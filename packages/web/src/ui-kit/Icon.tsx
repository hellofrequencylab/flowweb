import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Ban,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleCheckBig,
  CircleDashed,
  CircleDot,
  CircleHelp,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  ClockAlert,
  Coins,
  Copy,
  Ellipsis,
  ExternalLink,
  File,
  FileMinus,
  FilePlus,
  Hand,
  Info,
  Keyboard,
  Laptop,
  Lock,
  LogOut,
  type LucideIcon,
  MessageCircleWarning,
  OctagonX,
  Pencil,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Settings,
  ShieldCheck,
  ShieldX,
  Square,
  Sunrise,
  Terminal,
  TriangleAlert,
  WifiOff,
  X,
} from 'lucide-react';

/**
 * Lucide glyphs (the design system's icon set). The first group are status
 * shapes: each status has a distinct shape and a word, never colour alone.
 */
const ICONS = {
  // status shapes
  pass: CircleCheck,
  fail: CircleX,
  warn: TriangleAlert,
  unknown: CircleHelp,
  notverified: CircleDashed,
  skipped: Ban,
  waiting: Hand,
  running: Activity,
  paused: CirclePause,
  stopped: OctagonX,
  halted: Square,
  open: Circle,
  ready: CircleDot,
  blocked: CircleSlash,
  problem: CircleAlert,
  clock: Clock,
  lock: Lock,
  dot: CircleDot,
  verified: ShieldCheck,
  checking: ScanSearch,
  concerns: MessageCircleWarning,
  'shield-x': ShieldX,
  done: CircleCheckBig,
  // navigation
  dawn: Sunrise,
  table: Hand,
  ledger: BookOpen,
  runs: Activity,
  spend: Coins,
  settings: Settings,
  more: Ellipsis,
  // actions and details
  search: Search,
  copy: Copy,
  check: Check,
  x: X,
  'chevron-right': ChevronRight,
  'chevron-down': ChevronDown,
  'arrow-right': ArrowRight,
  'arrow-left': ArrowLeft,
  retry: RotateCcw,
  refresh: RefreshCw,
  'wifi-off': WifiOff,
  delayed: ClockAlert,
  info: Info,
  terminal: Terminal,
  file: File,
  'file-plus': FilePlus,
  'file-minus': FileMinus,
  pencil: Pencil,
  external: ExternalLink,
  keyboard: Keyboard,
  machine: Laptop,
  'log-out': LogOut,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 14,
  label,
  strokeWidth = 1.75,
}: {
  name: IconName;
  size?: number;
  label?: string;
  strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      className="icon"
    />
  );
}
