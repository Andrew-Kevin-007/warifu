// View model for /security: typography only. The prose comes from the lane's static markdown renderer.
import type { Slot } from '../../design/types';

export interface SecurityModel {
  title: string;
  /** table of contents entries; ids must be the heading anchors the lane rendered */
  toc: { id: string; title: string }[];
  /** the lane-rendered prose (StaticMarkdownPage); styled by .sy-prose */
  prose: Slot;
  /** optional two-column claims block */
  claims?: { we: Slot; wedont: Slot };
  /** contact block (card-black) */
  contact?: Slot;
}
