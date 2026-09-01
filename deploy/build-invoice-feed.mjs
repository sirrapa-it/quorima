#!/usr/bin/env node
// Quorima — factuurfeed-generator (Hermes → Quorima)
//
// Bouwt `dashboard/data/invoice-overview.json` (contract quorima.invoice-overview.v1)
// uit de run-artifacts die de Hermes Gmail factuur-pipeline al schrijft. Dit is
// het koppelpunt dat lang alleen op papier bestond: de spec beschreef het, maar
// niemand schreef het bestand.
//
// HARDE UITGANGSPUNTEN
//   - READ-ONLY. Dit script raakt Gmail niet aan, gebruikt geen tokens en
//     muteert geen enkel Hermes-artifact. Het leest JSON van schijf en schrijft
//     één bestand in dashboard/data/.
//   - NOOIT EEN CIJFER ZONDER BRON. Bedrag en vervaldatum staan in de artifacts
//     alleen als vrije tekst in de mailbody, niet als veld. We nemen ze
//     uitsluitend over bij een ondubbelzinnige match; in elk ander geval `null`.
//     Een leeg veld is bruikbaar, een gegokt bedrag is gevaarlijk.
//
// Gebruik:
//   node deploy/build-invoice-feed.mjs [--artifacts <dir>] [--out <file>] [--quiet]

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

const ARTIFACT_ROOT = process.env.HERMES_ARTIFACT_ROOT ?? "/home/hermes/.hermes/run-artifacts";
const ARTIFACT_PREFIX = "gmail-finops-";

// Entiteitscodes zoals de Hermes register-evaluatie ze gebruikt → Twinfield office.
// SPG boekt op Xero en heeft dus geen office-code.
const OFFICE_BY_ENTITY = { SIT: "21005", SGH: "21006", SVG: "21007", SPG: null };

/**
 * Zwakste vorm van entiteitsbepaling: de mailbox waarop de factuur binnenkwam.
 *
 * De unified spec is hier expliciet over — "een entiteit die alleen uit de
 * ontvangende mailbox volgt is confidence inferred en is NIET genoeg om te
 * forwarden". Deze feed is een overzicht en neemt geen boekingsbesluit, dus we
 * mogen de afleiding tonen; het confidence-niveau gaat mee zodat niemand er
 * een Basecone-routering op baseert. Een SaaS-factuur op de holding-mailbox
 * hoort bijvoorbeeld vaak bij SIT, niet bij SGH.
 *
 * De mapping zelf staat NIET in deze (publieke) repo: een complete lijst van
 * mailboxen met financiële toegang hoort niet op GitHub. Hij komt uit
 * `deploy/invoice-feed.config.json` (gitignored) — zie het .example-bestand.
 * Ontbreekt de config, dan werkt alles gewoon, alleen zonder de mailbox-terugval.
 */
async function loadMailboxMap(configPath) {
  try {
    const cfg = JSON.parse(await readFile(configPath, "utf-8"));
    return cfg.entity_by_mailbox ?? {};
  } catch {
    return null;
  }
}

// Labels → contract-status. Volgorde is bewust: specifiek vóór generiek, want
// een mail draagt vaak zowel `Invoice` als een sub-label.
const STATUS_BY_LABEL = [
  ["Admin/Finance/Invoice/Automatic direct debit", "incasso"],
  ["Admin/Finance/Invoice/Still to pay", "still-to-pay"],
  ["Admin/Finance/Invoice/Payment monitor", "monitor"],
];
// Al door Basecone verwerkt = geen openstaande post meer.
const CLOSED_LABEL = "Admin/Finance/Basecone processed";
const FORWARDED_LABEL = "Admin/Finance/Basecone forwarded";

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    artifacts: get("--artifacts"),
    out: get("--out"),
    quiet: argv.includes("--quiet"),
  };
}

/** Nieuwste gmail-finops-* map. De mapnaam is chronologisch sorteerbaar. */
async function latestArtifactDir(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const runs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(ARTIFACT_PREFIX))
    .map((e) => e.name)
    .sort();
  if (runs.length === 0) throw new Error(`geen ${ARTIFACT_PREFIX}* runs in ${root}`);
  return join(root, runs[runs.length - 1]);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf-8"));
}

// ─── Voorzichtige extractie ────────────────────────────────────────────
//
// De body is vrije tekst van tientallen verschillende leveranciers. We nemen
// alleen over wat ondubbelzinnig is: een bedrag dat direct achter een
// totaal-aanduiding staat, en dan nog alleen als alle vondsten hetzelfde
// bedrag opleveren. Twee verschillende kandidaten → null.

const AMOUNT_CUE =
  /(?:totaal(?:bedrag)?(?:\s+te\s+betalen)?|te\s+betalen|factuurbedrag|amount\s+due|total\s+amount|total)\D{0,25}?(?:€|EUR)?\s*([0-9][0-9.,\s]{2,15})/gi;

/** "1.234,56" (NL) en "1,234.56" (EN) → 1234.56. Geeft null bij twijfel. */
function toNumber(raw) {
  const s = raw.replace(/\s/g, "");
  if (!/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized;
  if (lastComma > lastDot) normalized = s.replace(/\./g, "").replace(",", ".");
  else if (lastDot > lastComma) normalized = s.replace(/,/g, "");
  else normalized = s.replace(/[.,]/g, "");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return Math.round(n * 100) / 100;
}

function extractAmount(body) {
  if (!body) return null;
  const found = new Set();
  for (const m of body.matchAll(AMOUNT_CUE)) {
    const n = toNumber(m[1]);
    if (n != null) found.add(n);
  }
  // Precies één consistent bedrag, anders weten we het niet.
  return found.size === 1 ? [...found][0] : null;
}

const DATE_CUE =
  /(?:vervaldatum|verval\s*datum|uiterlijk|due\s*date|betalen\s+voor|te\s+voldoen\s+voor)\D{0,20}?(\d{1,2})[-/\s](\d{1,2}|[a-z]{3,9})[-/\s](\d{4})/gi;

const NL_MONTHS = {
  jan: 1, feb: 2, mrt: 3, maa: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
  mar: 3, may: 5, oct: 10,
};

function extractDueDate(body) {
  if (!body) return null;
  const found = new Set();
  for (const m of body.matchAll(DATE_CUE)) {
    const day = Number(m[1]);
    const monthRaw = m[2].toLowerCase();
    const month = /^\d+$/.test(monthRaw)
      ? Number(monthRaw)
      : NL_MONTHS[monthRaw.slice(0, 3)];
    const year = Number(m[3]);
    if (!month || month < 1 || month > 12 || day < 1 || day > 31) continue;
    found.add(
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    );
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Afzendernaam uit een From-header: "Naam <adres>" → "Naam". */
function supplierFrom(from = "") {
  const named = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (named) return named[1].trim();
  const addr = from.match(/([^\s<>@]+)@/);
  return addr ? addr[1] : from.trim() || "onbekend";
}

/** Basecone noemt in zijn bevestiging de administratie + het bestand. */
function referenceFrom(candidate) {
  const body = candidate.body ?? "";
  const file = body.match(/([A-Za-z0-9_.-]+\.pdf)/);
  if (file) return file[1];
  const att = (candidate.attachments ?? []).find((a) => a?.filename);
  if (att) return att.filename;
  const subj = candidate.headers?.subject ?? "";
  const nr = subj.match(/\b(?:factuur|invoice|nota)\s*(?:nr\.?|nummer|no\.?|#)?\s*([A-Z0-9][A-Z0-9/.-]{3,})/i);
  return nr ? nr[1] : null;
}

/**
 * Status uit de labels, of null als de mail geen routeringsklasse draagt.
 *
 * Een kale `Admin/Finance/Invoice` zonder sub-label is volgens de unified spec
 * klasse 3: een bon die al per pinpas betaald is ("geen monitoring, label en
 * archiveer"). Die hoort niet in een overzicht van openstaande posten — anders
 * staat je PayPal-bonnetje van mei tussen de te betalen facturen.
 */
function statusFor(labels) {
  for (const [label, status] of STATUS_BY_LABEL) {
    if (labels.includes(label)) return status;
  }
  return null;
}

/** Date-header → YYYY-MM-DD. Null als hij onleesbaar is. */
function mailDate(raw = "") {
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function candidatesOf(account) {
  const c = account.candidates;
  if (!c) return [];
  return Array.isArray(c) ? c : Object.values(c);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => { if (!args.quiet) console.log(m); };

  const dir = args.artifacts ?? (await latestArtifactDir(ARTIFACT_ROOT));
  log(`» factuurfeed uit ${dir}`);

  const here = dirname(new URL(import.meta.url).pathname);
  const entityByMailbox = await loadMailboxMap(
    process.env.QUORIMA_INVOICE_CONFIG ?? join(here, "invoice-feed.config.json"),
  );
  if (entityByMailbox === null) {
    log("  ⚠ geen invoice-feed.config.json — entiteit alleen uit register-evaluation");
  }

  const discovery = await readJson(join(dir, "invoice-discovery.json"));
  // register-evaluation levert de entiteit per bericht; ontbreekt hij, dan
  // draaien we door met entity=null in plaats van te raden.
  let entityById = new Map();
  try {
    const reg = await readJson(join(dir, "register-evaluation.json"));
    entityById = new Map(
      (reg.evaluations ?? []).map((e) => [e.id, { entity: e.entity, confidence: e.resolution_level ?? null }]),
    );
    log(`  entiteiten uit register-evaluation: ${entityById.size}`);
  } catch {
    log("  ⚠ geen register-evaluation.json — entiteit blijft leeg");
  }

  const invoices = [];
  let skippedClosed = 0;
  let skippedNoClass = 0;
  const seen = new Set();

  for (const [account, data] of Object.entries(discovery.accounts ?? {})) {
    for (const c of candidatesOf(data)) {
      const labels = c.labels ?? [];
      if (labels.includes(CLOSED_LABEL)) { skippedClosed += 1; continue; }
      const status = statusFor(labels);
      if (!status) { skippedNoClass += 1; continue; }
      if (seen.has(c.id)) continue;
      seen.add(c.id);

      // Register eerst (hard bewijs), mailbox alleen als terugval.
      const reg = entityById.get(c.id);
      const entity = reg?.entity ?? (entityByMailbox ?? {})[account] ?? null;
      const entityConfidence = reg?.entity
        ? (reg.confidence ?? "register")
        : (entity ? "inferred-mailbox" : null);
      const headers = c.headers ?? {};
      invoices.push({
        entity,
        entity_confidence: entityConfidence,
        office: entity ? (OFFICE_BY_ENTITY[entity] ?? null) : null,
        supplier: supplierFrom(headers.from),
        reference: referenceFrom(c),
        amount_eur: extractAmount(c.body),
        due_date: extractDueDate(c.body),
        mail_date: mailDate(headers.date),
        status,
        link: `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${c.id}`,
        note: labels.includes(FORWARDED_LABEL) ? "doorgestuurd naar Basecone" : null,
        account,
      });
    }
  }

  // Eén factuur komt vaak in meerdere mails binnen (origineel + herinnering).
  // Samenvoegen mag alleen als we het écht zeker weten: zelfde leverancier,
  // zelfde bedrag én zelfde vervaldatum, en alle drie bekend. Ontbreekt er
  // één, dan blijven het aparte regels — liever een dubbele regel dan een
  // factuur die stilletjes verdwijnt.
  const merged = new Map();
  for (const inv of invoices) {
    const key =
      inv.amount_eur != null && inv.due_date != null
        ? `${inv.supplier.toLowerCase()}|${inv.amount_eur}|${inv.due_date}`
        : `uniek:${inv.link}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...inv, mail_count: 1 });
    } else {
      prev.mail_count += 1;
      // Houd de oudste mail aan als eerste signaal, en de rijkste referentie.
      if (inv.mail_date && (!prev.mail_date || inv.mail_date < prev.mail_date)) {
        prev.mail_date = inv.mail_date;
      }
      prev.reference ??= inv.reference;
      prev.entity ??= inv.entity;
      prev.entity_confidence ??= inv.entity_confidence;
      prev.office ??= inv.office;
    }
  }
  const deduped = [...merged.values()];
  const mergedAway = invoices.length - deduped.length;
  invoices.length = 0;
  invoices.push(...deduped);

  // Vervaldatum eerst (die vragen als eerste aandacht), daarna oudste mail
  // bovenaan — zo valt meteen op wat al maanden meeloopt.
  invoices.sort((a, b) =>
    (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") ||
    (a.mail_date ?? "9999").localeCompare(b.mail_date ?? "9999"));

  const withAmount = invoices.filter((i) => i.amount_eur != null).length;
  const withDue = invoices.filter((i) => i.due_date != null).length;
  const withEntity = invoices.filter((i) => i.entity != null).length;

  const feed = {
    schema: "quorima.invoice-overview.v1",
    generated_at: new Date().toISOString(),
    source: "Hermes Gmail factuur-pipeline (Freya) · run-artifacts",
    source_run: dir.split("/").pop(),
    accounts: Object.keys(discovery.accounts ?? {}),
    // Expliciet zichtbaar hoeveel we écht weten. Het dashboard toont dit, zodat
    // een leeg bedrag als "onbekend" leest en niet als "€0".
    coverage: {
      invoices: invoices.length,
      with_amount: withAmount,
      with_due_date: withDue,
      with_entity: withEntity,
      with_entity_confirmed: invoices.filter((i) => i.entity_confidence && i.entity_confidence !== "inferred-mailbox").length,
      oldest_mail_date: invoices.reduce(
        (o, i) => (i.mail_date && (!o || i.mail_date < o) ? i.mail_date : o),
        null,
      ),
    },
    invoices,
  };

  const out = args.out ?? resolve(dirname(new URL(import.meta.url).pathname), "../dashboard/data/invoice-overview.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(feed, null, 2) + "\n", "utf-8");

  log(`  ${invoices.length} openstaande facturen (${skippedClosed} al verwerkt, ${skippedNoClass} bonnen zonder routeringsklasse, ${mergedAway} dubbele mails samengevoegd)`);
  log(`  bedrag ${withAmount}/${invoices.length} · vervaldatum ${withDue}/${invoices.length} · entiteit ${withEntity}/${invoices.length}`);
  log(`  geschreven: ${out}`);
}

main().catch((err) => {
  console.error(`[quorima] factuurfeed mislukt: ${err.message}`);
  process.exit(1);
});
