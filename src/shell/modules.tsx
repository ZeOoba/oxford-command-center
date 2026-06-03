import { lazy, type ComponentType } from 'react';
import {
  LayoutDashboard,
  Target,
  Building2,
  FileText,
  Landmark,
  Wallet,
  ShieldCheck,
  LineChart,
  CheckSquare,
  Users,
  Activity,
  type LucideIcon,
} from 'lucide-react';

// Each module is its own code-split chunk — only the active one loads.
const OverviewModule = lazy(() => import('@/modules/overview/OverviewModule').then((m) => ({ default: m.OverviewModule })));
const AcquisitionsModule = lazy(() => import('@/modules/acquisitions/AcquisitionsModule').then((m) => ({ default: m.AcquisitionsModule })));
const PortfolioModule = lazy(() => import('@/modules/portfolio/PortfolioModule').then((m) => ({ default: m.PortfolioModule })));
const LeasesModule = lazy(() => import('@/modules/leases/LeasesModule').then((m) => ({ default: m.LeasesModule })));
const DebtModule = lazy(() => import('@/modules/debt/DebtModule').then((m) => ({ default: m.DebtModule })));
const CashModule = lazy(() => import('@/modules/cash/CashModule').then((m) => ({ default: m.CashModule })));
const InsuranceModule = lazy(() => import('@/modules/insurance/InsuranceModule').then((m) => ({ default: m.InsuranceModule })));
const MarketModule = lazy(() => import('@/modules/market/MarketModule').then((m) => ({ default: m.MarketModule })));
const TasksModule = lazy(() => import('@/modules/tasks/TasksModule').then((m) => ({ default: m.TasksModule })));
const RelationshipsModule = lazy(() => import('@/modules/relationships/RelationshipsModule').then((m) => ({ default: m.RelationshipsModule })));
const HealthModule = lazy(() => import('@/modules/health/HealthModule').then((m) => ({ default: m.HealthModule })));

export type ModuleGroup = 'Command' | 'Assets' | 'Capital' | 'Market';

export interface ModuleDef {
  id: string;
  label: string;
  icon: LucideIcon;
  group: ModuleGroup;
  Component: ComponentType;
}

/** The module registry — drop a new entry here and it appears in the rail. */
export const MODULES: ModuleDef[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'Command', Component: OverviewModule },
  { id: 'pipeline', label: 'Acquisitions', icon: Target, group: 'Command', Component: AcquisitionsModule },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, group: 'Command', Component: TasksModule },
  { id: 'portfolio', label: 'Portfolio', icon: Building2, group: 'Assets', Component: PortfolioModule },
  { id: 'leases', label: 'Leases', icon: FileText, group: 'Assets', Component: LeasesModule },
  { id: 'debt', label: 'Debt', icon: Landmark, group: 'Capital', Component: DebtModule },
  { id: 'cash', label: 'Cash', icon: Wallet, group: 'Capital', Component: CashModule },
  { id: 'insurance', label: 'Insurance', icon: ShieldCheck, group: 'Capital', Component: InsuranceModule },
  { id: 'market', label: 'Market', icon: LineChart, group: 'Market', Component: MarketModule },
  { id: 'relationships', label: 'Relationships', icon: Users, group: 'Market', Component: RelationshipsModule },
  { id: 'health', label: 'System Health', icon: Activity, group: 'Market', Component: HealthModule },
];

export const MODULE_GROUPS: ModuleGroup[] = ['Command', 'Assets', 'Capital', 'Market'];
