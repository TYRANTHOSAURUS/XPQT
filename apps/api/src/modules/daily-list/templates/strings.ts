/**
 * Per-locale string bundles for the catering daily-list PDF.
 *
 * Vendors print these PDFs in their kitchens — the strings MUST be in
 * the vendor's language so the printout reads naturally to the staff
 * making the food. Module identifiers are English (see daily-list.module.ts
 * top-doc) but the rendered output stays localised.
 *
 * Sprint 4 ships NL + FR + EN + DE. Adding a 5th locale: extend
 * `LOCALES`, add a strings entry, run the existing tests.
 */

export type DailyListLocale = 'nl' | 'fr' | 'en' | 'de';

export interface DailyListStrings {
  /** Document title metadata (PDF reader title bar). */
  documentTitle: string;
  /** Header H1 — large bold line at the top of every page. */
  header: string;
  /** "All buildings" fallback when payload.building is null. */
  allBuildings: string;
  /** "For {vendorName}" subtitle line. */
  forVendor: (vendorName: string) => string;
  /** Version meta-row label. */
  versionLabel: string;
  /** Generated-at meta-row label. */
  generatedLabel: string;
  /** Source meta-row label ("auto" / "manual" admin-triggered). */
  sourceLabel: string;
  sourceAuto: string;
  sourceManual: string;
  /** Totals bar labels. */
  ordersLabel: string;
  totalQuantityLabel: string;
  /** Per-line "For {firstName}" prefix. */
  forRequester: (firstName: string) => string;
  forRequesterUnknown: string;
  /** Per-line "{headcount} people" suffix when headcount is set. */
  headcountSuffix: (count: number) => string;
  /** Dietary-notes block prefix. */
  dietaryPrefix: string;
  /** Footer brand line. */
  footerBrand: string;
  /** Footer pagination "{n} of {total}" formatter. */
  footerPagination: (n: number, total: number) => string;
  /** Format a YYYY-MM-DD as a long-form date in this locale. */
  formatDate: (ymd: string) => string;
}

const monthsNL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
const monthsFR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
const monthsEN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const monthsDE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

function formatDateWith(months: string[]) {
  return (ymd: string) => {
    const [y, m, d] = ymd.split('-').map((n) => Number(n));
    if (!y || !m || !d) return ymd;
    return `${d} ${months[m - 1]} ${y}`;
  };
}

const NL: DailyListStrings = {
  documentTitle: 'Daglijst',
  header: 'Daglijst catering',
  allBuildings: 'Alle gebouwen',
  forVendor: (n) => `Voor ${n}`,
  versionLabel: 'Versie',
  generatedLabel: 'Aangemaakt',
  sourceLabel: 'Bron',
  sourceAuto: 'automatisch',
  sourceManual: 'handmatig',
  ordersLabel: 'Bestellingen',
  totalQuantityLabel: 'Totale hoeveelheid',
  forRequester: (n) => `Voor ${n}`,
  forRequesterUnknown: 'Voor: onbekend',
  headcountSuffix: (c) => ` · ${c} ${c === 1 ? 'persoon' : 'personen'}`,
  dietaryPrefix: 'Dieetwensen',
  footerBrand: 'Geleverd via Prequest',
  footerPagination: (n, t) => `${n} van ${t}`,
  formatDate: formatDateWith(monthsNL),
};

const FR: DailyListStrings = {
  documentTitle: 'Liste du jour',
  header: 'Liste du jour — restauration',
  allBuildings: 'Tous les bâtiments',
  forVendor: (n) => `Pour ${n}`,
  versionLabel: 'Version',
  generatedLabel: 'Généré',
  sourceLabel: 'Source',
  sourceAuto: 'automatique',
  sourceManual: 'manuel',
  ordersLabel: 'Commandes',
  totalQuantityLabel: 'Quantité totale',
  forRequester: (n) => `Pour ${n}`,
  forRequesterUnknown: 'Pour : inconnu',
  headcountSuffix: (c) => ` · ${c} ${c === 1 ? 'personne' : 'personnes'}`,
  dietaryPrefix: 'Régime',
  footerBrand: 'Livré via Prequest',
  footerPagination: (n, t) => `${n} sur ${t}`,
  formatDate: formatDateWith(monthsFR),
};

const EN: DailyListStrings = {
  documentTitle: 'Daily list',
  header: 'Daily list — catering',
  allBuildings: 'All buildings',
  forVendor: (n) => `For ${n}`,
  versionLabel: 'Version',
  generatedLabel: 'Generated',
  sourceLabel: 'Source',
  sourceAuto: 'automatic',
  sourceManual: 'manual',
  ordersLabel: 'Orders',
  totalQuantityLabel: 'Total quantity',
  forRequester: (n) => `For ${n}`,
  forRequesterUnknown: 'For: unknown',
  headcountSuffix: (c) => ` · ${c} ${c === 1 ? 'person' : 'people'}`,
  dietaryPrefix: 'Dietary notes',
  footerBrand: 'Delivered via Prequest',
  footerPagination: (n, t) => `${n} of ${t}`,
  formatDate: formatDateWith(monthsEN),
};

const DE: DailyListStrings = {
  documentTitle: 'Tagesliste',
  header: 'Tagesliste — Catering',
  allBuildings: 'Alle Gebäude',
  forVendor: (n) => `Für ${n}`,
  versionLabel: 'Version',
  generatedLabel: 'Erstellt',
  sourceLabel: 'Quelle',
  sourceAuto: 'automatisch',
  sourceManual: 'manuell',
  ordersLabel: 'Bestellungen',
  totalQuantityLabel: 'Gesamtmenge',
  forRequester: (n) => `Für ${n}`,
  forRequesterUnknown: 'Für: unbekannt',
  headcountSuffix: (c) => ` · ${c} ${c === 1 ? 'Person' : 'Personen'}`,
  dietaryPrefix: 'Diät',
  footerBrand: 'Geliefert über Prequest',
  footerPagination: (n, t) => `${n} von ${t}`,
  formatDate: formatDateWith(monthsDE),
};

const BUNDLES: Record<DailyListLocale, DailyListStrings> = { nl: NL, fr: FR, en: EN, de: DE };

/**
 * Resolve a locale string to a strings bundle. Falls back to NL — the
 * vast majority of paper vendors today are NL/BE; spec §11 says "default
 * NL when language unset."
 */
export function getStrings(locale: string | null | undefined): DailyListStrings {
  if (locale && (locale === 'nl' || locale === 'fr' || locale === 'en' || locale === 'de')) {
    return BUNDLES[locale];
  }
  return BUNDLES.nl;
}
