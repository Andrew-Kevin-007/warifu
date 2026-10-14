// View model for /challenge. No wallet, no storage, no network: the lane owns every behaviour.
import type { Mode, Slot } from '../../design/types';

export interface ChallengeTile {
  /** ATK-nn / BC-n identifier (validated, from the catalogue) */
  id: string;
  /** plain-English caption from the catalogue */
  caption: string;
}

export interface ScoreboardModel {
  /** distinct human attempts, integer count */
  distinctHuman: number;
  /** loss events, integer count */
  lossEvents: number;
  /** oracle predicate -> count, only entries with count > 0 are shown */
  byPredicate: { predicate: string; count: number }[];
  /** lane-formatted upper bound (rule of three); null when distinctHuman is 0 */
  upperBound: Slot | null;
  /** oracle disagreement flag */
  oracleDisagrees?: boolean;
  /** lane link to the incident note when lossEvents > 0 */
  incidentLink?: Slot;
}

export interface ChallengeModel {
  mode: Mode;
  scoreboard: ScoreboardModel;
  oneClick: ChallengeTile[];
  benign: ChallengeTile[];
  /** increments each time a result lands; drives the wave when a scene is mounted */
  resultTick: number;
  scenarios: { id: string; label: string }[];
  maxBytes: number;
  /** id of the active tile (result panel is pinned beside it) */
  activeTileId?: string | null;
  disabledTileIds?: string[];
  slots: {
    modeBar?: Slot;
    degradeBanner?: Slot;
    captcha?: Slot;
    resultPanel?: Slot;
    certificate?: Slot;
    proveOnchain?: Slot;
    crossOrigin?: Slot;
    disclaimer?: Slot;
    writeYourOwn?: Slot;
  };
  /** when set, the body renders tiles as buttons and reports a selection */
  onSelectTile?: (id: string) => void;
}
