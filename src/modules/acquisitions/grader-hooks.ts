// src/modules/acquisitions/grader-hooks.ts
//
// Data hooks for the OM Grader (GraderView + PipelineTierBoard). Deliberately thin — both hooks
// delegate to the EXISTING acquisition client surface instead of re-deriving it (CLAUDE.md §10
// duplication prevention: search for existing implementations before adding a new one):
//
//   - useGradeAcquisition(): wraps acquisition-score.ts's scoreDealRequest (the same
//     POST /api/warehouse/acquisition/score call, with the same 503/non-JSON →
//     AcquisitionEngineUnavailable semantics AcquisitionWorkbench already relies on) in a
//     TanStack `useMutation`, then Zod-parses the response through the AcquisitionScore contract
//     so a malformed engine payload throws at the client boundary instead of flowing through as
//     an unchecked cast.
//   - useAcqIntel: re-exported verbatim from hooks.ts (GET /api/warehouse/acq/intel via
//     fetchParsedOrMirror, the same pattern src/modules/debt/hooks.ts uses). A second
//     implementation here would drift from the ranked-candidate shape the moment either one
//     changed — see RankedCandidateList.tsx / AcquisitionsIntel.tsx, which already consume it.
import { useMutation } from '@tanstack/react-query';
import { AcquisitionScore } from '@contracts/acquisition';
import { scoreDealRequest, isEngineUnavailable, AcquisitionEngineUnavailable } from './acquisition-score';

export { useAcqIntel } from './hooks';
export { isEngineUnavailable, AcquisitionEngineUnavailable };

/**
 * Score an assembled AcquisitionInput body (see acquisition-score.ts's `buildInput`) against the
 * ratified engine. Resolves to a Zod-validated AcquisitionScore; rejects with
 * AcquisitionEngineUnavailable when the brain server / route is unreachable, or a generic Error
 * for a well-formed-but-rejected request (400/other).
 */
export function useGradeAcquisition() {
  return useMutation({
    mutationFn: async (input: Record<string, unknown>): Promise<AcquisitionScore> => {
      const raw = await scoreDealRequest(input);
      return AcquisitionScore.parse(raw);
    },
  });
}
