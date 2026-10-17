'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import ChallengeBody from '../pages/challenge/ChallengeBody';
import WriteYourOwnPlate from '../pages/challenge/WriteYourOwnPlate';
import type { ScoreboardModel } from '../pages/challenge/types';
import { ModeTag } from '../design/primitives/Tag';
import { LiveAttemptResult, RecordedAttemptResult } from './AttemptResult';
import type { AttemptView, ConsoleInitial, Stats } from './types';
import '../../styles/design-challenge.css';

type Shown = { kind: 'live'; attempt: AttemptView; title: string } | { kind: 'recorded'; id: string; title: string } | null;

const SCENARIO_LABELS: Record<string, string> = { 'S-A': 'Design contractor', 'S-B': 'Developer, CI evidence', 'S-C': 'Vendor, 2/10 net 30' };

interface ApiOk<T> {
  source: 'LIVE';
  data: T;
}

async function call<T>(path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; status: number; code: string; level: string | null; retryAfter: number | null }> {
  try {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as (Partial<ApiOk<T>> & { code?: string; level?: string; detail?: { level?: string } }) | null;
    if (res.ok && json?.data !== undefined) return { ok: true, data: json.data };
    const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    return { ok: false, status: res.status, code: json?.code ?? 'ERROR', level: json?.detail?.level ?? json?.level ?? null, retryAfter: Number.isFinite(ra) ? ra : null };
  } catch {
    return { ok: false, status: 0, code: 'NETWORK', level: 'L2', retryAfter: null };
  }
}

function boundText(s: Stats): ReactNode {
  const n = s.attempts.distinctHuman;
  if (n === 0 || s.lossEvents.total > 0) return null;
  const pct = Math.min(100, 300 / n);
  return (
    <span>
      {pct.toFixed(pct < 10 ? 1 : 0)}% <span className="sy-muted">(3 ÷ {n})</span>
    </span>
  );
}

export default function ChallengeConsole({ initial }: { initial: ConsoleInitial }) {
  const [mode, setMode] = useState<'live' | 'recorded'>(initial.mode);
  const [stats, setStats] = useState<Stats | null>(initial.stats);
  const [active, setActive] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const catalog = initial.catalog;
  const level = catalog?.status.level ?? 'L2';
  const live = mode === 'live';
  const titles = useMemo(() => {
    const t: Record<string, string> = {};
    for (const a of catalog?.oneClick ?? []) t[a.attackId] = a.title;
    return t;
  }, [catalog]);

  const showRecorded = useCallback(
    (id: string) => setShown({ kind: 'recorded', id, title: titles[id] ?? initial.tiles.find((t) => t.id === id)?.caption ?? id }),
    [initial.tiles, titles],
  );

  const refreshStats = useCallback(async () => {
    const r = await call<Stats>('/api/public/challenge/stats');
    if (r.ok) setStats(r.data);
  }, []);

  const send = useCallback(
    async (body: unknown, id: string, title: string) => {
      setBusy(true);
      setNotice(null);
      const r = await call<AttemptView>('/api/public/challenge/attempts', body);
      setBusy(false);
      if (r.ok) {
        setShown({ kind: 'live', attempt: r.data, title });
        setTick((t) => t + 1);
        void refreshStats();
        return;
      }
      if (r.status === 429) setNotice(`Easy: too many attempts from here. Try again in ${r.retryAfter ?? 60} seconds.`);
      else if (r.status === 503 && r.level === 'L1') setNotice('Free-form attempts are off right now. One-click attacks and benign controls still run.');
      else if (r.status === 413 || r.status === 422 || r.status === 400) setNotice('The document must be plain text of at most 4096 bytes, with a milestone from the scenario.');
      else {
        setMode('recorded');
        setNotice('The live sandbox is not answering, so the recorded results are shown instead.');
        if (id !== '') showRecorded(id);
      }
    },
    [refreshStats, showRecorded],
  );

  const onSelectTile = useCallback(
    (id: string) => {
      setActive(id);
      const oc = catalog?.oneClick.find((a) => a.attackId === id);
      if (id.startsWith('ATK-')) {
        // An attack that needs the deployed vault or reconciler is shown from the recorded matrix, labelled so.
        if (!live || oc === undefined || !oc.runnable) return showRecorded(id);
        void send({ kind: 'oneclick', attackId: id }, id, oc.title);
      } else if (live) {
        void send({ kind: 'benign', benignId: id }, id, catalog?.benign.find((b) => b.id === id)?.caption ?? id);
      }
    },
    [catalog, live, send, showRecorded],
  );

  const scenarios = useMemo(() => (catalog?.scenarios ?? [{ scenarioId: 'S-A' }, { scenarioId: 'S-B' }, { scenarioId: 'S-C' }]).map((s) => ({ id: s.scenarioId, label: SCENARIO_LABELS[s.scenarioId] ?? s.scenarioId })), [catalog]);
  // The milestone choice is remembered per scenario; the picker renders under the scenario selector (the plate calls afterScenario).
  const [milestoneBy, setMilestoneBy] = useState<Record<string, string>>({});
  const milestonesOf = (scenarioId: string): { slug: string; description: string }[] => catalog?.scenarios.find((s) => s.scenarioId === scenarioId)?.milestones ?? [];
  const milestoneFor = (scenarioId: string): string => {
    const ms = milestonesOf(scenarioId);
    const picked = milestoneBy[scenarioId];
    return ms.some((m) => m.slug === picked) ? (picked as string) : (ms[0]?.slug ?? '');
  };

  const scoreboard: ScoreboardModel = {
    distinctHuman: stats?.attempts.distinctHuman ?? 0,
    lossEvents: stats?.lossEvents.total ?? 0,
    byPredicate: Object.entries(stats?.lossEvents.byPredicate ?? {}).filter(([, n]) => n > 0).map(([predicate, count]) => ({ predicate, count })),
    upperBound: stats === null ? null : boundText(stats),
  };

  const freeFormOn = live && (catalog?.status.freeFormAvailable ?? false);
  const writeYourOwn = (
    <div className="sy-cc__write">
      {freeFormOn ? null : (
        <p className="body-text-s sy-muted sy-cc__off">
          {live ? 'Free-form attempts are paused (the sandbox model budget is used up or no model key is set). One-click attacks and benign controls still run.' : 'Free-form attempts need the live sandbox.'}
        </p>
      )}
      <WriteYourOwnPlate
        maxBytes={catalog?.rules.maxTextBytes ?? 4096}
        scenarios={scenarios}
        disabled={!freeFormOn || busy}
        afterScenario={(scenarioId) => (
          <div className="sy-cc__milestone">
            <label className="sy-mono" htmlFor="sy-cc-ms">Milestone the document is for</label>
            <select id="sy-cc-ms" className="sy-cc__select" value={milestoneFor(scenarioId)} disabled={!freeFormOn} onChange={(e) => setMilestoneBy((m) => ({ ...m, [scenarioId]: e.target.value }))}>
              {milestonesOf(scenarioId).map((m) => (
                <option key={m.slug} value={m.slug}>{m.description}</option>
              ))}
            </select>
          </div>
        )}
        onSubmit={freeFormOn ? ({ text, scenarioId }) => void send({ kind: 'freeform', scenarioId, milestoneSlug: milestoneFor(scenarioId), text }, '', 'Your document') : undefined}
      />
    </div>
  );

  const resultPanel =
    busy ? <p className="body-text-s sy-muted" aria-busy="true">Running the real kernel on a fresh scenario…</p> : shown === null ? null : shown.kind === 'live' ? <LiveAttemptResult attempt={shown.attempt} title={shown.title} /> : <RecordedAttemptResult id={shown.id} title={shown.title} row={initial.recorded[shown.id]} />;

  return (
    <ChallengeBody
      model={{
        mode: live ? 'live' : 'recorded',
        brandName: initial.brandName,
        scoreboard,
        oneClick: initial.tiles.filter((t) => t.id.startsWith('ATK-')),
        benign: (catalog?.benign ?? []).map((b) => ({ id: b.id, caption: b.caption })),
        resultTick: tick,
        scenarios,
        maxBytes: catalog?.rules.maxTextBytes ?? 4096,
        activeTileId: active,
        disabledTileIds: busy ? [...initial.tiles.map((t) => t.id), ...(catalog?.benign ?? []).map((b) => b.id)] : [],
        onSelectTile,
        slots: {
          modeBar: (
            <p className="sy-cc__mode">
              <ModeTag mode={live ? 'live' : 'recorded'} />
              <span className="body-text-s">
                {live
                  ? `Live sandbox · level ${level}. Attempts run on the real kernel against a fresh scenario each time.`
                  : `The sandbox is not answering, so this page shows the committed attack matrix${initial.bundleHash === null ? '' : ` (bundle ${initial.bundleHash.slice(0, 12)}…)`}. Nothing here is a live run.`}
              </span>
            </p>
          ),
          degradeBanner: notice === null ? undefined : <p className="sy-cc__notice body-text-s" role="status">{notice}</p>,
          resultPanel: resultPanel ?? undefined,
          writeYourOwn,
          disclaimer: (
            <p className="body-text-s">
              Testnet only. No cash prize. Attack traffic is not customer traffic and is never counted as traction. Synthetic data only: do not paste real invoices or personal data.
            </p>
          ),
        },
      }}
    />
  );
}
