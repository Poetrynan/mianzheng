import type { EvidenceRef, RejectedClaim, TranscriptSegment } from '../types.js';

/** What a provider is allowed to point at: a segment id, a verbatim quote, or both. */
export interface EvidenceClaim {
  segmentId?: string | null;
  quote?: string | null;
}

export interface EvidenceResolution {
  refs: EvidenceRef[];
  rejected: RejectedClaim[];
}

function normalize(s: string): string {
  return s.replace(/\s+/g, '').replace(/[，。、；：,.;:!?！？]/g, '').toLowerCase();
}

export class EvidenceVerifier {
  private readonly byId: Map<string, TranscriptSegment>;
  private readonly ordered: TranscriptSegment[];

  constructor(segments: TranscriptSegment[]) {
    this.ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
    this.byId = new Map(this.ordered.map((s) => [s.id, s]));
  }

  get size(): number {
    return this.ordered.length;
  }

  private findByQuote(quote: string): TranscriptSegment | undefined {
    const n = normalize(quote);
    if (n.length < 4) return undefined;
    return this.ordered.find((s) => normalize(s.text).includes(n) || n.includes(normalize(s.text)));
  }

  resolve(claims: EvidenceClaim[], dimensionId: string | null, claimText: string): EvidenceResolution {
    const refs: EvidenceRef[] = [];
    const rejected: RejectedClaim[] = [];
    const seen = new Set<string>();

    for (const claim of claims) {
      let segment: TranscriptSegment | undefined;
      if (claim.segmentId) {
        segment = this.byId.get(claim.segmentId);
        if (!segment) {
          rejected.push({
            dimensionId,
            claim: claimText,
            reason: 'unknown_segment',
          });
          continue;
        }
      } else if (claim.quote) {
        segment = this.findByQuote(claim.quote);
        if (!segment) {
          rejected.push({
            dimensionId,
            claim: claimText,
            reason: 'quote_not_in_transcript',
          });
          continue;
        }
      } else {
        rejected.push({ dimensionId, claim: claimText, reason: 'no_evidence' });
        continue;
      }

      if (seen.has(segment.id)) continue;
      seen.add(segment.id);
      /** The stored quote is always the DB copy, never the model's retelling. */
      refs.push({ segmentId: segment.id, startMs: segment.startMs, quote: segment.text });
    }

    // A conclusion that pointed at nothing at all is itself a rejected claim: the review UI
    // must show the gap instead of silently rendering an unevidenced score.
    if (refs.length === 0 && rejected.length === 0) {
      rejected.push({ dimensionId, claim: claimText, reason: 'no_evidence' });
    }

    return { refs, rejected };
  }

  /** Used by the review UI to render AI text side by side with the real transcript. */
  textOf(segmentId: string): string | null {
    return this.byId.get(segmentId)?.text ?? null;
  }
}

export function hasAnyEvidence(refs: EvidenceRef[]): boolean {
  return refs.length > 0;
}
