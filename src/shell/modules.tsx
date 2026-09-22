import { lazy, type ComponentType } from 'react';
import {
  LayoutDashboard,
  Target,
  Building2,
  ShieldCheck,
  LineChart,
  CheckSquare,
  Activity,
  Database,
  TrendingUp,
  Coins,
  BrainCircuit,
  BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { INTEL_TABS } from '@/modules/intel/tabs';
import { DATA_TABS } from '@/modules/data/tabs';
import { WORKLIST_TABS } from '@/modules/worklist/tabs';
import { CAPITAL_TABS } from '@/modules/capital/tabs';
import { MARKET_TABS } from '@/modules/market/tabs';
import { OBLIGATIONS_TABS } from '@/modules/obligations/tabs';
import { LEASING_TABS } from '@/modules/leasing/tabs';
import { BRAIN_TABS } from '@/modules/command-brain/tabs';
import { ACQUISITIONS_TABS } from '@/modules/acquisitions/tabs';
import { LEASE_MARKET_TABS } from '@/modules/lease-market/tabs';
import type { ModuleTabDef } from './tab-types';

// Each module is its own code-split chunk — only the active one loads.
const OverviewModule = lazy(() => import('@/modules/overview/OverviewModule').then((m) => ({ default: m.OverviewModule })));
const AcquisitionsModule = lazy(() => import('@/modules/acquisitions/AcquisitionsModule').then((m) => ({ default: m.AcquisitionsModule })));
const PortfolioModule = lazy(() => import('@/modules/portfolio/PortfolioModule').then((m) => ({ default: m.PortfolioModule })));
const ObligationsModule = lazy(() => import('@/modules/obligations/ObligationsModule').then((m) => ({ default: m.ObligationsModule })));
const MarketModule = lazy(() => import('@/modules/market/MarketModule').then((m) => ({ default: m.MarketModule })));
const HealthModule = lazy(() => import('@/modules/health/HealthModule').then((m) => ({ default: m.HealthModule })));
const IntelModule = lazy(() => import('@/modules/intel/IntelModule').then((m) => ({ default: m.IntelModule })));
const WorklistModule = lazy(() => import('@/modules/worklist/WorklistModule').then((m) => ({ default: m.WorklistModule })));
const DataModule = lazy(() => import('@/modules/data/DataModule').then((m) => ({ default: m.DataModule })));
const LeaseForecastModule = lazy(() => import('@/modules/leasing/LeaseForecastModule').then((m) => ({ default: m.LeaseForecastModule })));
const CapitalModule = lazy(() => import('@/modules/capital/CapitalModule').then((m) => ({ default: m.CapitalModule })));
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
  { id: 'pipeline', label: 'Acquisitions', icon: Target, group: 'Command', Component: AcquisitionsModule, tabs: ACQUISITIONS_TABS },
  { id: 'worklist', label: 'Worklist', icon: CheckSquare, group: 'Command', Component: WorklistModule, tabs: WORKLIST_TABS },
  { id: 'command-brain', label: 'Brain', icon: BrainCircuit, group: 'Command', Component: CommandBrainModule, tabs: BRAIN_TABS },
  { id: 'portfolio', label: 'Portfolio', icon: Building2, group: 'Assets', Component: PortfolioModule },
  // Financials — module id stays `intel` so /intel/:propertyId deep links + MODULE_PRIMARY_TYPE keep working.
  { id: 'intel', label: 'Financials', icon: BarChart3, group: 'Assets', Component: IntelModule, tabs: INTEL_TABS },
  { id: 'leasing', label: 'Leasing', icon: TrendingUp, group: 'Assets', Component: LeaseForecastModule, tabs: LEASING_TABS },
  { id: 'capital', label: 'Capital', icon: Coins, group: 'Capital', Component: CapitalModule, tabs: CAPITAL_TABS },
  { id: 'obligations', label: 'Obligations', icon: ShieldCheck, group: 'Capital', Component: ObligationsModule, tabs: OBLIGATIONS_TABS },
  { id: 'market', label: 'Market', icon: LineChart, group: 'Market', Component: MarketModule, tabs: MARKET_TABS },
  { id: 'lease-market', label: 'Lease Market', icon: Building2, group: 'Market', Component: LeaseMarketModule, tabs: LEASE_MARKET_TABS },
  { id: 'data', label: 'Data', icon: Database, group: 'System', Component: DataModule, tabs: DATA_TABS },
  // System Health left the rail in Phase 4a — it is a TopBar status dot; /health still resolves.
  { id: 'health', label: 'System Health', icon: Activity, group: 'System', Component: HealthModule, rail: false },
];

export const MODULE_GROUPS: ModuleGroup[] = ['Command', 'Assets', 'Capital', 'Market', 'System'];
