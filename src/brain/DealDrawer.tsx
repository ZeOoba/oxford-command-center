import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Mail, ChevronRight, RefreshCw, ExternalLink, Lock } from 'lucide-react';
import type { PortfolioSnapshot, Deal, DealStage, CompSet, AcquisitionInput, AcquisitionScore, RankedCandidate } from '@contracts/index';
import type { DraftRequest } from './draft';
import { fmtUsd, fmtUsdCompact, fmtPct, fmtSf, fmtNum, fmtMultiple, fmtDate } from '@analytics/index';
import { SNAPSHOT_KEY } from '@/data/queries';
import { refreshDealComps } from '@/data/actions';
import { replacementCostAnalysis } from './replacement-cost';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { GaugeRing } from '@/primitives/GaugeRing';
import { useAcqIntel } from '@/modules/acquisitions/grader-hooks';

const STAGE_FLOW: DealStage[] = ['Sourcing', 'Candidate', 'LOI/PSA', 'Due Diligence', 'Closing', 'Closed'];
const nextStage = (s: DealStage): DealStage | null => {
  const i = STAGE_FLOW.indexOf(s);
  return i >= 0 && i < STAGE_FLOW.length - 1 ? STAGE_FLOW[i + 1]! : null;
};

// Tier/verdict → gauge + badge tone. Mirrors GraderView.tsx's gaugeTone / TIER_BADGE_TONE
// (each acquisition-score consumer keeps its own small tone table — see also
// RankedCandidateList.tsx's TIER_STYLES and AcquisitionWorkbench.tsx's VERDICT_TONE).
const TIER_BADGE_TONE: Record<AcquisitionScore['tier'], BadgeTone> = {
  T1: 'gold',
  T2: 'blue',
  PASS: 'neutral',
  KILLED: 'red',
};
function gaugeTone(tier: AcquisitionScore['tier']): 'pos' | 'warn' | 'neg' {
  if (tier === 'T1') return 'pos';
  if (tier === 'T2') return 'warn';
  return 'neg'; // PASS | KILLED
}

/** Find the ranked acquisition candidate synced to this deal (Deal.id === candidate.notionDealId —
 *  the same linkage PipelineTierBoard.tsx uses to open a deal from a scored candidate). Returns the
 *  SAME RankedCandidate/AcquisitionScore object useAcqIntel already resolved elsewhere in the app —
 *  never recomputed or re-derived here, so the figures shown match the Grader/Pipeline board exactly. */
function findRankedCandidateForDeal(candidates: RankedCandidate[], dealId: string): RankedCandidate | null {
  return candidates.find((c) => c.candidate.notionDealId === dealId) ?? null;
}

export function DealDrawer({
  dealId, snapshot, canWrite, onClose, onDraft, onAdvanceStage,
}: {
  dealId: string;
  snapshot: PortfolioSnapshot;
  canWrite: boolean;
  onClose: () => void;
  onDraft: (req: DraftRequest) => void;
  onAdvanceStage: (dealId: string, stage: DealStage, label: string) => void;
}) {
  const qc = useQueryClient();
  const deal = snapshot.deals.find((d) => d.id === dealId) ?? null;
  const comps: CompSet | undefined = snapshot.dealComps[dealId];
  const acqInput: AcquisitionInput | null = snapshot.acquisitionInputs[dealId] ?? null;
  const { data: acqIntel } = useAcqIntel();
  const rankedCandidate = findRankedCandidateForDeal(acqIntel?.rankedCandidates ?? [], dealId);
  const refresh = useMutation({
    mutationFn: () => refreshDealComps(dealId),
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ns = deal ? nextStage(deal.stage) : null;
  const rc = deal ? replacementCostAnalysis(deal) : null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Deal detail">
      <motion.div className="absolute inset-0" style={{ background: 'rgba(2,4,8,0.5)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside
        className="absolute right-0 top-0 flex h-full w-[1180px] max-w-[96vw] flex-col"
        style={{ background: 'var(--surface-raised)', borderLeft: '1px solid var(--border-strong)' }}
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
      >
        {!deal ? (
          <div className="grid flex-1 place-items-center text-sm" style={{ color: 'var(--text-tertiary)' }}>Deal not found.</div>
        ) : (
          <>
            <header className="flex items-start justify-between gap-3 px-6 py-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <div className="min-w-0">
                <div className="mb-1.5 flex items-center gap-2">
                  <Badge tone={deal.confidential ? 'purple' : 'gold'}>Deal</Badge>
                  <Badge tone="neutral">{deal.stage}</Badge>
                  {deal.confidential && <span className="flex items-center gap-1 text-2xs" style={{ color: 'var(--text-accent2)' }}><Lock size={11} /> Confidential</span>}
                </div>
                <h2 className="display text-xl leading-tight" style={{ color: 'var(--text-primary)' }}>{deal.name}</h2>
                <p className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{deal.location ?? deal.market ?? '—'}</p>
              </div>
              <button onClick={onClose} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)]" style={{ border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                <X size={15} />
              </button>
            </header>

            <div className="flex min-h-0 flex-1">
              {/* LEFT — cards + stage track */}
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="mb-4 flex flex-wrap gap-2">
                  <button onClick={() => onDraft({ kind: 'loi', entity: { type: 'deal', id: deal.id } })} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 35%, transparent)', color: 'var(--text-accent)' }}>
                    <Mail size={13} /> Draft LOI handoff
                  </button>
                  {ns && canWrite && (
                    <button onClick={() => onAdvanceStage(deal.id, ns, `Advance to ${ns}`)} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] px-3 py-1.5 text-xs font-semibold" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}>
                      Advance to {ns} <ChevronRight size={13} />
                    </button>
                  )}
                </div>

                <StageTrack stage={deal.stage} />

                <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <CardBox title="Deal Detail">
                    <Row label="Market" value={deal.market ?? '—'} />
                    <Row label="Location" value={deal.location ?? '—'} />
                    <Row label="Square Feet" value={deal.sf !== null ? fmtSf(deal.sf) : '—'} />
                    <Row label="Buildings" value={deal.buildings ?? '—'} />
                    <Row label="Owner" value={deal.owner ?? '—'} />
                    <Row label="Target Close" value={fmtDate(deal.targetCloseDate)} />
                    <Row label="Next Action" value={deal.nextAction ?? '—'} />
                    <Row label="Status" value={deal.status ?? '—'} />
                  </CardBox>

                  <CardBox title="Returns">
                    <ReturnsBar label="Cap Rate" pct={deal.capRate} display={fmtPct(deal.capRate, 2)} scaleMaxPct={0.12} />
                    <ReturnsBar label="Levered IRR" pct={deal.irr} display={fmtPct(deal.irr)} scaleMaxPct={0.30} />
                    <ReturnsBar label="Equity Multiple" pct={deal.equityMultiple !== null ? deal.equityMultiple / 3 : null} display={deal.equityMultiple !== null ? fmtMultiple(deal.equityMultiple) : '—'} scaleMaxPct={1} />
                    <Row label="Hold" value={deal.holdYrs !== null ? `${deal.holdYrs} yr` : '—'} />
                  </CardBox>

                  <CardBox title="Underwriting Assumptions">
                    <Row label="Est. Price" value={fmtUsdCompact(deal.estPrice)} />
                    <Row label="Price / SF" value={deal.estPrice !== null && deal.sf ? `$${(deal.estPrice / deal.sf).toFixed(0)}` : '—'} />
                    <Row label="Cap Rate" value={fmtPct(deal.capRate, 2)} />
                    <Row label="Hold Period" value={deal.holdYrs !== null ? `${deal.holdYrs} yr` : '—'} />
                    {deal.estimatedFields.length > 0 && (
                      <div className="pt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Estimated: {deal.estimatedFields.join(', ')}</div>
                    )}
                  </CardBox>

                  <CardBox title="Financing">
                    <Row label="Lender" value={deal.lender ?? '—'} />
                    <Row label="Est. Price" value={fmtUsdCompact(deal.estPrice)} />
                    <div className="pt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Debt terms set at LOI/PSA — see Debt module once financed.</div>
                  </CardBox>

                  <CardBox title="Replacement Cost">
                    {rc ? (
                      <>
                        <Row label="Basis" value={rc.basis} />
                        <Row label="Replacement (range)" value={`${fmtUsdCompact(rc.low)} – ${fmtUsdCompact(rc.high)}`} />
                        <Row label="Replacement (mid)" value={fmtUsd(rc.mid)} />
                        <Row label="Price vs. Replacement" value={rc.priceToReplacementMid !== null ? `${(rc.priceToReplacementMid * 100).toFixed(0)}% of mid` : '—'} />
                        {rc.verdict && (
                          <div className="pt-1">
                            <Badge tone={rc.verdict === 'Discount to replacement' ? 'green' : rc.verdict === 'Premium to replacement' ? 'red' : 'amber'}>{rc.verdict}</Badge>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>SF unknown — cannot compute replacement cost.</div>
                    )}
                  </CardBox>

                  <CardBox title="Risk Flags">
                    <RiskFlags deal={deal} />
                  </CardBox>

                  <div className="lg:col-span-2">
                    <UnderwritingSection input={acqInput} candidate={rankedCandidate} />
                  </div>
                </div>
              </div>

              {/* RIGHT — comps panel */}
              <aside className="flex w-[360px] max-w-[42vw] shrink-0 flex-col overflow-y-auto" style={{ borderLeft: '1px solid var(--border-subtle)', background: 'color-mix(in oklab, var(--surface-overlay) 40%, transparent)' }}>
                <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Market Comps</div>
                    <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                      {comps ? `AI-sourced · cached ${fmtDate(comps.sourcedAt.slice(0, 10))}` : 'Not yet researched'}
                    </div>
                  </div>
                  {canWrite && (
                    <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="flex items-center gap-1 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-2xs font-semibold" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-strong)', color: 'var(--text-primary)', opacity: refresh.isPending ? 0.6 : 1 }} aria-label="Refresh market comps">
                      <RefreshCw size={12} className={refresh.isPending ? 'animate-spin' : ''} /> {comps ? 'Refresh' : 'Research'}
                    </button>
                  )}
                </div>

                <div className="flex flex-col gap-4 px-4 py-3">
                  {refresh.isPending && <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>Researching comps via web search… this can take ~20s.</div>}
                  {refresh.isError && <div className="text-2xs" style={{ color: 'var(--text-neg)' }}>{(refresh.error as Error)?.message ?? 'Comp research failed.'}</div>}

                  {!comps && !refresh.isPending ? (
                    <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                      {canWrite ? 'No comps yet — click Research to web-search sale, rent, and submarket comparables.' : 'No comps cached. Refresh requires the live Brain Server.'}
                    </div>
                  ) : comps ? (
                    <>
                      {comps.summary && <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{comps.summary}</p>}

                      <CompSection title={`Sale Comps (${comps.saleComps.length})`}>
                        {comps.saleComps.map((sc, i) => (
                          <div key={i} className="rounded-[var(--radius-sm)] p-2" style={{ background: 'var(--surface-overlay)' }}>
                            <div className="text-2xs font-semibold" style={{ color: 'var(--text-primary)' }}>{sc.address}</div>
                            <div className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                              {[sc.price !== null ? fmtUsdCompact(sc.price) : null, sc.pricePerSf !== null ? `$${fmtNum(sc.pricePerSf)}/SF` : null, sc.capRate !== null ? `${(sc.capRate * 100).toFixed(2)}% cap` : null, sc.date].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <SourceLink source={sc.source} />
                          </div>
                        ))}
                      </CompSection>

                      <CompSection title={`Rent Comps (${comps.rentComps.length})`}>
                        {comps.rentComps.map((rcp, i) => (
                          <div key={i} className="rounded-[var(--radius-sm)] p-2" style={{ background: 'var(--surface-overlay)' }}>
                            <div className="text-2xs font-semibold" style={{ color: 'var(--text-primary)' }}>{rcp.address}</div>
                            <div className="num text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                              {[rcp.rentPerSf !== null ? `$${fmtNum(rcp.rentPerSf)}/SF` : null, rcp.sf !== null ? fmtSf(rcp.sf) : null, rcp.leaseType, rcp.date].filter(Boolean).join(' · ') || '—'}
                            </div>
                            <SourceLink source={rcp.source} />
                          </div>
                        ))}
                      </CompSection>

                      <CompSection title={`Submarket (${comps.submarketStats.length})`}>
                        {comps.submarketStats.map((st, i) => (
                          <div key={i} className="flex items-center justify-between gap-2 text-2xs">
                            <span style={{ color: 'var(--text-tertiary)' }}>{st.label}</span>
                            <span className="num" style={{ color: 'var(--text-primary)' }}>{st.value}</span>
                          </div>
                        ))}
                      </CompSection>

                      {comps.sources.length > 0 && (
                        <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
                          Sources: {comps.sources.length} · AI-sourced, verify before relying on figures.
                        </div>
                      )}
                    </>
                  ) : null}
                </div>
              </aside>
            </div>
          </>
        )}
      </motion.aside>
    </div>
  );
}

function StageTrack({ stage }: { stage: DealStage }) {
  const idx = STAGE_FLOW.indexOf(stage);
  return (
    <div className="flex items-center gap-1">
      {STAGE_FLOW.map((s, i) => {
        const done = idx >= 0 && i <= idx;
        return (
          <div key={s} className="flex flex-1 flex-col items-center gap-1">
            <div className="h-1 w-full rounded-full" style={{ background: done ? 'var(--accent)' : 'var(--border-subtle)' }} />
            <span className="text-[9px] uppercase" style={{ letterSpacing: '0.06em', color: i === idx ? 'var(--text-primary)' : 'var(--text-tertiary)', fontWeight: i === idx ? 700 : 400 }}>{s}</span>
          </div>
        );
      })}
    </div>
  );
}

function CardBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] p-3" style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}>
      <div className="mb-2 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>{title}</div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1" style={{ borderTop: '1px solid color-mix(in oklab, var(--border-subtle) 60%, transparent)' }}>
      <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span className="num text-right text-xs" style={{ color: 'var(--text-primary)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function ReturnsBar({ label, pct, display, scaleMaxPct }: { label: string; pct: number | null; display: string; scaleMaxPct: number }) {
  const w = pct !== null && scaleMaxPct > 0 ? Math.max(0, Math.min(100, (pct / scaleMaxPct) * 100)) : 0;
  return (
    <div className="py-1">
      <div className="mb-0.5 flex items-center justify-between">
        <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
        <span className="num text-xs" style={{ color: 'var(--text-primary)' }}>{display}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-raised)' }}>
        <div className="h-full rounded-full" style={{ width: `${w}%`, background: 'var(--accent)' }} />
      </div>
    </div>
  );
}

function RiskFlags({ deal }: { deal: Deal }) {
  const flags: string[] = [];
  if (deal.confidential) flags.push('Confidential — internal only, no external surface');
  if (deal.stage === 'Dead') flags.push('Deal is marked Dead');
  if (deal.capRate === null) flags.push('Cap rate not set');
  if (deal.estPrice === null) flags.push('Estimated price not set');
  if (deal.sf === null) flags.push('Square footage unknown');
  if (deal.estimatedFields.length > 0) flags.push(`Estimated figures: ${deal.estimatedFields.join(', ')}`);
  if (flags.length === 0) return <div className="text-2xs" style={{ color: 'var(--text-pos)' }}>No flags.</div>;
  return (
    <ul className="flex flex-col gap-1">
      {flags.map((f, i) => (
        <li key={i} className="flex items-start gap-1.5 text-2xs" style={{ color: 'var(--text-secondary)' }}>
          <span style={{ color: 'var(--text-warn)' }}>•</span> {f}
        </li>
      ))}
    </ul>
  );
}

/**
 * Underwriting panel (IMPLEMENTATION_PLAN task 7.4): a compact read-only summary of the deal's saved
 * AcquisitionInput (overlay-sourced, see `PortfolioSnapshot.acquisitionInputs`), plus — when the deal
 * has been synced to a scored acquisition candidate — the persisted Oxford Acquisition Score gauge,
 * tier/verdict badge, and top reasons. The score is rendered from the SAME RankedCandidate object
 * useAcqIntel() resolves for RankedCandidateList/PipelineTierBoard — never recomputed here — so the
 * figures are identical to what the Acquisitions module shows for this deal.
 */
function UnderwritingSection({ input, candidate }: { input: AcquisitionInput | null; candidate: RankedCandidate | null }) {
  if (!input) {
    return (
      <CardBox title="Underwriting">
        <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          No underwriting input captured yet — grade this deal in the Acquisitions module&apos;s Grader tab.
        </div>
      </CardBox>
    );
  }

  const score: AcquisitionScore | null = candidate?.latestScore ?? null;

  return (
    <CardBox title="Underwriting">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
        <div className="flex flex-col gap-0.5">
          <Row label="Price" value={fmtUsdCompact(input.price)} />
          <Row label="Total SF" value={input.totalSf !== null ? fmtSf(input.totalSf) : '—'} />
          <Row label="Clear Height" value={input.clearHeightFt !== null ? `${fmtNum(input.clearHeightFt)} ft` : '—'} />
          <Row label="Product Type" value={input.productType ?? '—'} />
          <Row label="All-in Basis" value={fmtUsdCompact(input.allInBasis)} />
          <Row label="Stabilized YoC" value={fmtPct(input.stabilizedYoc)} />
          <Row label="Levered IRR" value={fmtPct(input.leveredIrr)} />
          <Row label="Horizon" value={input.underwriteHorizonYrs !== null ? `${input.underwriteHorizonYrs} yr` : '—'} />
        </div>

        <div className="flex flex-col items-center gap-2 md:w-[190px]">
          {score ? (
            <>
              <GaugeRing value={score.composite} tone={gaugeTone(score.tier)} label={`${score.tier} · ${score.verdict}`} size={92} />
              <Badge tone={TIER_BADGE_TONE[score.tier]}>{score.tier}</Badge>
              {score.reasons.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-2xs" style={{ color: 'var(--text-secondary)' }}>
                  {score.reasons.slice(0, 3).map((r, i) => (
                    <li key={i}>· {r}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <div className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              Not yet scored — grade this input in the Acquisitions module&apos;s Grader tab to produce an Oxford Acquisition Score.
            </div>
          )}
        </div>
      </div>
    </CardBox>
  );
}

function CompSection({ title, children }: { title: string; children: React.ReactNode }) {
  const arr = Array.isArray(children) ? children : [children];
  return (
    <div>
      <div className="mb-1.5 text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>{title}</div>
      {arr.length === 0 ? <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>None found.</div> : <div className="flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}

function SourceLink({ source }: { source: string }) {
  const isUrl = /^https?:\/\//.test(source);
  if (!isUrl) return <div className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{source}</div>;
  return (
    <a href={source} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-accent)' }}>
      <ExternalLink size={9} /> source
    </a>
  );
}
