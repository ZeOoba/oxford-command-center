import { lazy, type ComponentType } from 'react';
import {
  LayoutDashboard,
  Target,
  Building2,
  FileText,
  ShieldCheck,
  LineChart,
  CheckSquare,
  Contact,
  Activity,
  Briefcase,
  Database,
  TrendingUp,
  Radar,
  Coins,
  Lightbulb,
  Receipt,
  BrainCircuit,
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { INTEL_TABS } from '@/modules/intel/tabs';
import { DATA_TABS } from '@/modules/data/tabs';
import { WORKLIST_TABS } from '@/modules/worklist/tabs';
import { CAPITAL_TABS } from '@/modules/capital/tabs';
import type { ModuleTabDef } from './tab-types';

// Each module is its own code-split chunk — only the active one loads.
const OverviewModule = lazy(() => import('@/modules/overview/OverviewModule').then((m) => ({ default: m.OverviewModule })));
const AcquisitionsModule = lazy(() => import('@/modules/acquisitions/AcquisitionsModule').then((m) => ({ default: m.AcquisitionsModule })));
const PortfolioModule = lazy(() => import('@/modules/portfolio/PortfolioModule').then((m) => ({ default: m.PortfolioModule })));
const LeasesModule = lazy(() => import('@/modules/leases/LeasesModule').then((m) => ({ default: m.LeasesModule })));
const InsuranceModule = lazy(() => import('@/modules/insurance/InsuranceModule').then((m) => ({ default: m.InsuranceModule })));
const MarketModule = lazy(() => import('@/modules/market/MarketModule').then((m) => ({ default: m.MarketModule })));
const TenantsModule = lazy(() => import('@/modules/tenants/TenantsModule').then((m) => ({ default: m.TenantsModule })));
const HealthModule = lazy(() => import('@/modules/health/HealthModule').then((m) => ({ default: m.HealthModule })));
const PrincipalModule = lazy(() => import('@/modules/principal/PrincipalModule').then((m) => ({ default: m.PrincipalModule })));
const IntelModule = lazy(() => import('@/modules/intel/IntelModule').then((m) => ({ default: m.IntelModule })));
const WorklistModule = lazy(() => import('@/modules/worklist/WorklistModule').then((m) => ({ default: m.WorklistModule })));
const DataModule = lazy(() => import('@/modules/data/DataModule').then((m) => ({ default: m.DataModule })));
const LeaseForecastModule = lazy(() => import('@/modules/leasing/LeaseForecastModule').then((m) => ({ default: m.LeaseForecastModule })));
const CapitalModule = lazy(() => import('@/modules/capital/CapitalModule').then((m) => ({ default: m.CapitalModule })));
const ProspectDemandModule = lazy(() => import('@/modules/intel/ProspectDemandModule').then((m) => ({ default: m.ProspectDemandModule })));
const InsightsModule = lazy(() => import('@/modules/insights/InsightsModule').then((m) => ({ default: m.InsightsModule })));
const TaxesModule = lazy(() => import('@/modules/taxes/TaxesModule').then((m) => ({ default: m.TaxesModule })));
const CommandBrainModule = lazy(() => import('@/modules/command-brain/CommandBrainModule').then((m) => ({ default: m.CommandBrainModule })));
const LeaseMarketModule = lazy(() => import('@/modules/lease-market/LeaseMarketModule').then((m) => ({ default: m.LeaseMarketModule })));

export type ModuleGroup = 'Command' | 'Assets' | 'Capital' | 'Market' | 'System';

export interface ModuleDef {
  id: string;
  label: string;
  icon: LucideIcon;
  group: ModuleGroup;
  Component: ComponentType;
  /** Two-level registry (IA decongestion Phase 4a): the destination's tabs (`?tab=<id>`). Indexed by
   *  the command palette as "Destination > Tab". Max 5 (`MAX_TABS_PER_DESTINATION`). */
  tabs?: readonly ModuleTabDef[];
  /** False keeps the module routable (URL + palette) but off the sidebar rail (System Health —
   *  surfaced as a TopBar status dot). Default true. */
  rail?: boolean;
}

/** The module registry — drop a new entry here and it appears in the rail. */
export const MODULES: ModuleDef[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Command', Component: OverviewModule },
  { id: 'principal', label: 'Principal Home', icon: Briefcase, group: 'Command', Component: PrincipalModule },
  { id: 'pipeline', label: 'Acquisitions', icon: Target, group: 'Command', Component: AcquisitionsModule },
  { id: 'worklist', label: 'Worklist', icon: CheckSquare, group: 'Command', Component: WorklistModule, tabs: WORKLIST_TABS },
  { id: 'insights', label: 'Insights', icon: Lightbulb, group: 'Command', Component: InsightsModule },
  { id: 'command-brain', label: 'Command Brain', icon: BrainCircuit, group: 'Command', Component: CommandBrainModule },
  { id: 'portfolio', label: 'Portfolio', icon: Building2, group: 'Assets', Component: PortfolioModule },
  // Financials — module id stays `intel` so /intel/:propertyId deep links + MODULE_PRIMARY_TYPE keep working.
  { id: 'intel', label: 'Financials', icon: BarChart3, group: 'Assets', Component: IntelModule, tabs: INTEL_TABS },
  { id: 'leases', label: 'Leases', icon: FileText, group: 'Assets', Component: LeasesModule },
  { id: 'leasing', label: 'Leasing', icon: TrendingUp, group: 'Assets', Component: LeaseForecastModule },
  { id: 'prospect-demand', label: 'Demand Signals', icon: Radar, group: 'Assets', Component: ProspectDemandModule },
  { id: 'tenants', label: 'Tenants', icon: Contact, group: 'Assets', Component: TenantsModule },
  { id: 'capital', label: 'Capital', icon: Coins, group: 'Capital', Component: CapitalModule, tabs: CAPITAL_TABS },
  { id: 'insurance', label: 'Insurance', icon: ShieldCheck, group: 'Capital', Component: InsuranceModule },
  { id: 'taxes', label: 'Taxes', icon: Receipt, group: 'Capital', Component: TaxesModule },
  { id: 'market', label: 'Market', icon: LineChart, group: 'Market', Component: MarketModule },
  { id: 'lease-market', label: 'Lease Market', icon: Building2, group: 'Market', Component: LeaseMarketModule },
  { id: 'data', label: 'Data', icon: Database, group: 'System', Component: DataModule, tabs: DATA_TABS },
  // System Health left the rail in Phase 4a — it is a TopBar status dot; /health still resolves.
  { id: 'health', label: 'System Health', icon: Activity, group: 'System', Component: HealthModule, rail: false },
];

export const MODULE_GROUPS: ModuleGroup[] = ['Command', 'Assets', 'Capital', 'Market', 'System'];
