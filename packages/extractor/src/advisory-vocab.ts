// Closed vocabulary for the optional Advisory (AI) note (SEC review: a denylist cannot win, so the validator is an
// ALLOWLIST). Every word token in a note must be in this list, or be an exact fact token supplied per call (check ids,
// reason/anomaly codes and the words they are made of, the formatted amount, the decision's own verdict word forms).
// Anything else is rejected as OUT_OF_VOCABULARY, so a spelled-out number, a verdict-like word, a homoglyph word or
// an instruction cannot be smuggled through.
//
// Deliberately absent: all number words; "percent", "half", "twice", "double"; "safe", "approve*", "release";
// base-form action verbs that read as commands (pay, send, use, sign, confirm, verify, click); words that ADDRESS or
// DIRECT the reader (you, your, can, could, may, might, must, shall, should, will, would, need*, let*, go*, give*,
// get*, take*, make*, do*, wait*, come*, ask*); and reassurance adjectives (right, correct, valid, clear*, fine).
// Residual (ACCEPTED, QUESTIONS.md): allowed words can still be combined into a misleading sentence; the note is
// optional, collapsed, labelled advisory, never next to Approve, and never a release condition. Widening this list is
// a reviewed change (DOCS/SEC). Words are lower-case ASCII only.
const WORDS = `
a an the this that these those each every any some no none all both either neither other another same such own
it its they them their we our he she his her there here which who whom whose what when where why how whether
of in on at by for from to with without within about above below between into onto over under after before during against
as than like via per and or but nor so yet if then because while although though since until unless also only just still
even too very more most less least much many few several
is are was were be been being am have has had having
not never cannot
appear appears appeared look looks looked seem seems seemed show shows showed shown indicate indicates indicated suggest
suggests suggested mean means meant require requires required include includes included contain contains
contained match matches matched differ differs differed fail fails failed pass passes passed flag flags flagged raise raises
raised trigger triggers triggered note notes noted see sees seen checks checked reviews reviewed confirms confirmed verifies
verified compare compares compared reports reported state states stated prints printed signs signed changes changed uses used
sends sent receive receives received claim claims claimed list lists listed expect expects expected find finds found remain
remains remained stay stays
ambiguous unclear unusual unexpected unexpectedly missing different similar matching mismatched inconsistent consistent
incomplete invalid unknown known registered unregistered pending open closed late early new old previous current later
earlier first second last next final hidden visible possible likely unlikely certain uncertain incorrect wrong
exact partial full large small high low carefully closely closer manual manually additional extra further
payee wallet address invoice amount payment milestone engagement document documents terms term discount currency evidence
check reason reasons code codes verdict decision kernel human reviewer owner step steps field fields value values
number numbers date dates deadline window instruction instructions text anomaly anomalies signal signals detail details
difference differences party vendor supplier customer record records history limit limits cap balance fund funds vault policy
rule rules result results issue issues problem problems risk risks concern concerns case item items line lines total sum
figure figures name names bank account accounts identity binding mismatch duplicate duplicates copy copies request requests
format characters character source sources time period day days week weeks month months hour hours attention review
decisions threshold
`;

export const ADVISORY_VOCABULARY: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter((w) => w.length > 0));

/**
 * Words removed from the vocabulary because they address or direct the reader, or reassure ("no need to wait", "you
 * should send the funds", "the address is correct"). Kept here only so tests can show the earlier, wider vocabulary
 * accepted those phrases (negative controls). NEVER import this from production code.
 */
export const REMOVED_DIRECTING_WORDS: readonly string[] = [
  "you", "your", "can", "could", "may", "might", "must", "shall", "should", "will", "would", "need", "needs", "needed", "let", "lets",
  "go", "goes", "going", "went", "give", "gives", "given", "get", "gets", "got", "take", "takes", "taken", "make", "makes", "made",
  "do", "does", "did", "doing", "done", "wait", "waits", "waited", "come", "comes", "came", "ask", "asks", "asked",
  "right", "correct", "valid", "clear", "clearly", "fine",
];

/** Verdict word forms allowed for exactly one verdict (added per call, never the others). */
export const VERDICT_FORMS: Readonly<Record<"RELEASE" | "HOLD" | "ESCALATE" | "REJECT" | "REPLAY", readonly string[]>> = {
  RELEASE: ["release", "released", "releases"],
  HOLD: ["hold", "held", "holds"],
  ESCALATE: ["escalate", "escalated", "escalates", "escalating"],
  REJECT: ["reject", "rejected", "rejects"],
  REPLAY: ["replay", "replayed"],
};
