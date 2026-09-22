// Hand-written declaration file for commitmsg-trailer-guard.mjs, kept in sync manually.
//
// Not generated the way prepush-confidential-scan.d.mts is (see tsconfig.confidential-scan-types.json):
// that generator step is scoped to files outside this change's blast radius, and this guard's
// exported surface is small and stable (three names), so a hand-written declaration is the
// lower-footprint option here. Update this file if the .mjs's exported names or signatures change.
export declare const ALLOWED_AI_TRAILERS: string[];
export declare function findAiCoAuthorLines(message: string): string[];
export declare function validateAiTrailers(message: string): { ok: boolean; offending: string[] };
