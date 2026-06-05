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
  Bell,
  CalendarDays,
  RefreshCw,
  Contact,
  Users,
  Activity,
  FileSearch,
  Briefcase,
  Scale,
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
const AlertsModule = lazy(() => import('@/modules/alerts/AlertsModule').then((m) => ({ default: m.AlertsModule })));
const CalendarModule = lazy(() => import('@/modules/calendar/CalendarModule').then((m) => ({ default: m.CalendarModule })));
const RenewalsModule = lazy(() => import('@/modules/renewals/RenewalsModule').then((m) => ({ default: m.RenewalsModule })));
const TenantsModule = lazy(() => import('@/modules/tenants/TenantsModule').then((m) => ({ default: m.TenantsModule })));
const RelationshipsModule = lazy(() => import('@/modules/relationships/RelationshipsModule').then((m) => ({ default: m.RelationshipsModule })));
const HealthModule = lazy(() => import('@/modules/health/HealthModule').then((m) => ({ default: m.HealthModule })));
const DocumentsModule = lazy(() => import('@/modules/documents/DocumentsModule').then((m) => ({ default: m.DocumentsModule })));
const PrincipalModule = lazy(() => import('@/modules/principal/PrincipalModule').then((m) => ({ default: m.PrincipalModule })));
const CloseModule = lazy(() => import('@/modules/close/CloseModule').then((m) => ({ default: m.CloseModule })));

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
  { id: 'principal', label: 'Principal Home', icon: Briefcase, group: 'Command', Component: PrincipalModule },
  { id: 'pipeline', label: 'Acquisitions', icon: Target, group: 'Command', Component: AcquisitionsModule },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, group: 'Command', Component: TasksModule },
  { id: 'alerts', label: 'Alerts', icon: Bell, group: 'Command', Component: AlertsModule },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays, group: 'Command', Component: CalendarModule },
  { id: 'renewals', label: 'Renewals', icon: RefreshCw, group: 'Command', Component: RenewalsModule },
  { id: 'portfolio', label: 'Portfolio', icon: Building2, group: 'Assets', Component: PortfolioModule },
  { id: 'leases', label: 'Leases', icon: FileText, group: 'Assets', Component: LeasesModule },
  { id: 'tenants', label: 'Tenants', icon: Contact, group: 'Assets', Component: TenantsModule },
  { id: 'debt', label: 'Debt', icon: Landmark, group: 'Capital', Component: DebtModule },
  { id: 'cash', label: 'Cash', icon: Wallet, group: 'Capital', Component: CashModule },
  { id: 'close', label: 'Monthly Close', icon: Scale, group: 'Capital', Component: CloseModule },
  { id: 'insurance', label: 'Insurance', icon: ShieldCheck, group: 'Capital', Component: InsuranceModule },
  { id: 'market', label: 'Market', icon: LineChart, group: 'Market', Component: MarketModule },
  { id: 'relationships', label: 'Relationships', icon: Users, group: 'Market', Component: RelationshipsModule },
  { id: 'documents', label: 'Documents', icon: FileSearch, group: 'Market', Component: DocumentsModule },
  { id: 'health', label: 'System Health', icon: Activity, group: 'Market', Component: HealthModule },
];

export const MODULE_GROUPS: ModuleGroup[] = ['Command', 'Assets', 'Capital', 'Market'];
