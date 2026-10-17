// Wire types of the public challenge (the kernel's /v1/challenge/* answers, passed through apps/web/src/app/api/public/challenge/*).
// Everything here is codes, counts and amounts; the only attacker-derived string is `text.excerpt`, which the UI shows through <UntrustedText>.

export interface RunView {
  label: string;
  action: string;
  checksFired: string[];
  reasons: string[];
  release: { amountBaseUnits: string; payee: string; oracle: { result: 'LOSS' | 'NO_LOSS'; predicates: string[] }; lossBaseUnits: string } | null;
}

export interface EngineResult {
  engine: string;
  mode: 'UNIT';
  kind: 'oneclick' | 'benign' | 'freeform';
  attackId: string | null;
  benignId: string | null;
  scenarioId: string;
  action: string;
  checksFired: string[];
  reasons: string[];
  releases: number;
  lossReleases: number;
  lossBaseUnits: string;
  predicates: string[];
  oracleResult: 'NO_LOSS' | 'LOSS';
  outcome: string | null;
  benign: { released: boolean; amountMatches: boolean | null } | null;
  runs: RunView[];
  notRun: string[];
  steps: number;
}

export interface AttemptView {
  attemptId: string;
  createdAt: string;
  source: 'human' | 'oneclick';
  result: EngineResult;
  text: { excerpt: string; length: number; hash: string } | null;
  extractionRefused: string | null;
  /** Free-form only: who read the document, a model or the built-in keyless rule reader. */
  reader: 'model' | 'rules' | null;
  /** One signed receipt per run, verifiable at /audit/<hash>. Signed by the sandbox kernel signer; not anchored on-chain in unit mode. */
  receipts: { label: string; verdict: string; receiptHash: string }[];
}

export interface ChallengeStatus {
  level: 'L0' | 'L1' | 'L2';
  enabled: boolean;
  freeFormAvailable: boolean;
  reader: 'model' | 'rules' | null;
  budgetUsedBp: number;
}

export interface Catalog {
  status: ChallengeStatus;
  scenarios: { scenarioId: string; title: string; milestones: { slug: string; description: string; amountBaseUnits: string }[] }[];
  oneClick: { attackId: string; title: string; caption: string; runnable: boolean; note: string }[];
  benign: { id: string; caption: string; scenarioId: string }[];
  rules: { maxTextBytes: number; freeFormPerHour: number; freeFormPerDay: number; oneClickPerHour: number };
}

export interface Stats {
  asOf: string;
  attempts: { human: number; distinctHuman: number; house: number; oneClick: number };
  lossEvents: { total: number; byPredicate: Record<string, number> };
  benign: { n: number; falseRejects: number };
  upper95LossRate: number | null;
}

/** One recorded row of the committed attack matrix for the Warifu target (the fallback when the live sandbox is unreachable). */
export interface RecordedRow {
  outcome: string;
  checksFired: string[];
  lossBaseUnits: string;
  notes: string[];
}

export interface ConsoleInitial {
  mode: 'live' | 'recorded';
  catalog: Catalog | null;
  stats: Stats | null;
  /** The recorded set: always present, so a dead sandbox never leaves the page empty. */
  tiles: { id: string; caption: string }[];
  recorded: Record<string, RecordedRow>;
  bundleHash: string | null;
  brandName: string;
}
