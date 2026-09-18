import {
  createIcons as renderIcons, CircleAlert, TriangleAlert, Briefcase, Calendar, CalendarDays,
  Camera, CircleCheck, CircleDollarSign, Coins, ChartNoAxesColumn, HeartPulse, History,
  Landmark, LayoutDashboard, ChartLine, ChartPie, Plus, RotateCw, Save, Settings,
  ShieldCheck, TrendingUp, TrendingDown, Wallet, X, Loader,
} from 'lucide';

// 舊頁面使用的圖示別名映射到模組版，僅打包實際用到的圖示。
const icons = {
  AlertCircle: CircleAlert, AlertTriangle: TriangleAlert, Briefcase, Calendar, CalendarDays,
  Camera, CheckCircle: CircleCheck, CircleDollarSign, Coins, DonutChart: ChartNoAxesColumn,
  HeartPulse, History, Landmark, LayoutDashboard, LineChart: ChartLine, PieChart: ChartPie,
  Plus, RotateCw, Save, Settings, ShieldCheck, TrendingUp, TrendingDown, Wallet, X, Loader,
};

/** 將目前 DOM 內 data-lucide 轉為 SVG，延續原有呼叫方式。 */
export function createIcons() { renderIcons({ icons }); }
