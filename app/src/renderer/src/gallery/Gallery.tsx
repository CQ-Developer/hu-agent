/**
 * 设计画廊（dev-only，生产构建不包含）：方向 B「暖中性纸感」的令牌与组件视觉预览。
 *
 * 访问方式（不启动 Electron）：`npm run dev -- --rendererOnly` 后打开 `/gallery.html`。
 * 这里只演示令牌与视觉语言，不接入任何 IPC；迁移后的组件应与此处保持一致。
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'

type Theme = 'system' | 'light' | 'dark'
type Accent = 'clay' | 'moss' | 'ink'

const THEME_KEY = 'huagent.gallery.theme'
const ACCENT_KEY = 'huagent.gallery.accent'

function readTheme(): Theme {
  const value = localStorage.getItem(THEME_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

function readAccent(): Accent {
  const value = localStorage.getItem(ACCENT_KEY)
  return value === 'moss' || value === 'ink' ? value : 'clay'
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement
  root.classList.toggle('light', theme === 'light')
  root.classList.toggle('dark', theme === 'dark')
  root.dataset.theme = theme
}

function applyAccent(accent: Accent): void {
  document.documentElement.dataset.accent = accent
}

// ---------------------------------------------------------------- 布局零件

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-6 shadow-soft">
      <header className="mb-5">
        <h2 className="text-heading font-semibold tracking-tight">{title}</h2>
        {desc ? <p className="mt-1 text-small text-fg-muted">{desc}</p> : null}
      </header>
      {children}
    </section>
  )
}

function Swatch({ token, label }: { token: string; label: string }) {
  return (
    <div className="min-w-28 flex-1">
      <div
        className="h-14 rounded-field border border-line"
        style={{ background: `var(${token})` }}
        title={`var(${token})`}
      />
      <div className="mt-2 text-caption font-medium">{label}</div>
      <div className="font-num text-caption text-fg-subtle">{token}</div>
    </div>
  )
}

function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info' }) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-2 text-fg-muted border-line',
    accent: 'bg-accent-soft text-accent border-transparent',
    success: 'bg-success-soft text-success border-transparent',
    warning: 'bg-warning-soft text-warning border-transparent',
    danger: 'bg-danger-soft text-danger border-transparent',
    info: 'bg-info-soft text-info border-transparent',
  }
  return <span className={`inline-flex items-center rounded-chip border px-2.5 py-0.5 text-caption font-medium ${tones[tone]}`}>{children}</span>
}

function Button({
  children,
  variant = 'primary',
  size = 'md',
  onClick,
}: {
  children: ReactNode
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  onClick?: () => void
}) {
  const variants: Record<string, string> = {
    primary: 'bg-accent text-accent-contrast hover:bg-accent-hover shadow-soft',
    secondary: 'bg-surface-2 text-fg border border-line hover:bg-surface-3',
    ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
    danger: 'bg-danger text-fg-inverse hover:opacity-90 shadow-soft',
  }
  const sizes: Record<string, string> = {
    sm: 'px-3 py-1.5 text-caption',
    md: 'px-4 py-2 text-small',
    lg: 'px-5 py-2.5 text-body',
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center justify-center gap-1.5 rounded-field font-medium transition duration-200 ease-standard active:scale-[.97] ${variants[variant]} ${sizes[size]}`}
    >
      {children}
    </button>
  )
}

function Field({ label, placeholder, hint }: { label: string; placeholder: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-small font-medium text-fg">{label}</span>
      <input
        className="w-full rounded-field border border-line bg-surface-2 px-3 py-2 text-small text-fg outline-none transition duration-200 ease-standard placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-[var(--ui-accent-ring)]"
        placeholder={placeholder}
      />
      {hint ? <span className="mt-1 block text-caption text-fg-subtle">{hint}</span> : null}
    </label>
  )
}

// ---------------------------------------------------------------- 画廊本体

export default function Gallery() {
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [accent, setAccent] = useState<Accent>(readAccent)
  const [motionKey, setMotionKey] = useState(0)

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    applyAccent(accent)
    localStorage.setItem(ACCENT_KEY, accent)
  }, [accent])

  const replay = useCallback(() => setMotionKey((key) => key + 1), [])

  return (
    <div className="min-h-screen bg-canvas font-ui text-body text-fg">
      {/* 控制条 */}
      <div className="sticky top-0 z-20 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-6 py-3">
          <div className="mr-auto">
            <div className="text-title font-semibold">hu-agent 设计画廊</div>
            <div className="text-caption text-fg-subtle">dev-only · 方向 B 暖中性纸感 · 令牌与组件预览</div>
          </div>
          <Segmented
            value={theme}
            onChange={(value) => setTheme(value as Theme)}
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
          <Segmented
            value={accent}
            onChange={(value) => setAccent(value as Accent)}
            options={[
              { value: 'clay', label: '陶土' },
              { value: 'moss', label: '苔绿' },
              { value: 'ink', label: '墨蓝' },
            ]}
          />
        </div>
      </div>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
        <Section title="颜色 · 强调色" desc="强调色仅用于主操作、选中态与运行态；三个预设共用同一套语义位。">
          <div className="flex flex-wrap gap-4">
            <Swatch token="--ui-accent-soft" label="soft 底" />
            <Swatch token="--ui-accent" label="accent 主" />
            <Swatch token="--ui-accent-hover" label="hover" />
            <Swatch token="--ui-accent-contrast" label="对比文字" />
          </div>
        </Section>

        <Section title="颜色 · 暖中性" desc="画布是暖白纸感，卡面更白，层级靠表面与细边框，而不是重阴影。">
          <div className="flex flex-wrap gap-4">
            <Swatch token="--ui-canvas" label="canvas 画布" />
            <Swatch token="--ui-surface" label="surface 卡面" />
            <Swatch token="--ui-surface-2" label="surface-2 次级" />
            <Swatch token="--ui-surface-3" label="surface-3 选中" />
            <Swatch token="--ui-line" label="line 边框" />
            <Swatch token="--ui-line-strong" label="line-strong" />
          </div>
          <div className="mt-4 flex flex-wrap gap-4">
            <Swatch token="--ui-fg" label="fg 主文本" />
            <Swatch token="--ui-fg-muted" label="fg-muted 次文本" />
            <Swatch token="--ui-fg-subtle" label="fg-subtle 弱文本" />
          </div>
        </Section>

        <Section title="颜色 · 语义" desc="成功/警告/危险/信息：深浅色各一套，均带 soft 底用于徽标与提示条。">
          <div className="flex flex-wrap gap-4">
            <Swatch token="--ui-success" label="success" />
            <Swatch token="--ui-warning" label="warning" />
            <Swatch token="--ui-danger" label="danger" />
            <Swatch token="--ui-info" label="info" />
          </div>
        </Section>

        <Section title="字阶" desc="正文 14px / 行高 1.7；数字与代码使用等宽字体，便于对齐用量与模型名。">
          <div className="flex flex-col gap-3">
            <div className="text-display font-semibold">下午好，陈同学</div>
            <div className="text-heading font-semibold">会话标题与会话分组</div>
            <div className="text-title font-medium">卡片标题 / 模型名称</div>
            <div className="text-body text-fg-muted">
              正文：助手回复、说明文字与表单帮助。中英混排 body 14px，行高 1.7，长文本更易读。
            </div>
            <div className="text-small text-fg-muted">小号：列表项第二行、时间戳、标签说明。</div>
            <div className="text-caption text-fg-subtle">辅助：12px 仅用于弱提示，不再往下压。</div>
            <div className="font-num text-body">deepseek-v4.1-flash · 12,480 tokens · $0.0134</div>
          </div>
        </Section>

        <Section title="圆角 / 阴影" desc="B 方向使用更大的圆角与暖色投影，弹层比卡片多一层悬浮感。">
          <div className="flex flex-wrap items-center gap-6">
            <div className="grid h-24 w-40 place-items-center rounded-field border border-line bg-surface text-small shadow-soft">
              rounded-field
            </div>
            <div className="grid h-24 w-40 place-items-center rounded-card border border-line bg-surface text-small shadow-lift">
              rounded-card · lift
            </div>
            <div className="grid h-24 w-40 place-items-center rounded-panel border border-line bg-surface text-small shadow-pop">
              rounded-panel · pop
            </div>
          </div>
        </Section>

        <Section title="按钮与输入" desc="四个变体 × 三个尺寸；聚焦态用强调色描边 + 2px 光环。">
          <div className="flex flex-wrap items-center gap-3">
            <Button>发送</Button>
            <Button variant="secondary">新建会话</Button>
            <Button variant="ghost">取消</Button>
            <Button variant="danger">删除会话</Button>
            <Button size="sm">小按钮</Button>
            <Button size="lg">大按钮</Button>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <Field label="API Key" placeholder="sk-…" hint="仅写入系统密钥库，不会出现在日志或诊断包中。" />
            <Field label="模型名称" placeholder="deepseek-v4.1-flash" />
          </div>
        </Section>

        <Section title="徽标与状态" desc="状态色是语义色的唯一出口；运行中用强调色呼吸点。">
          <div className="flex flex-wrap items-center gap-3">
            <Chip tone="accent">市场已上架</Chip>
            <Chip tone="success">已完成</Chip>
            <Chip tone="warning">待审批</Chip>
            <Chip tone="danger">已被服务端停用</Chip>
            <Chip tone="info">本地 Skill</Chip>
            <Chip>
              <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-breathe rounded-chip bg-accent" />
              运行中
            </Chip>
          </div>
        </Section>

        <Section title="卡片样例" desc="对话、工具与审批卡的视觉基线：细边框 + 圆角 + 暖阴影。">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-card border border-line bg-surface p-4 shadow-soft">
              <div className="text-small font-semibold">工具调用 · read_file</div>
              <div className="mt-1 font-num text-caption text-fg-subtle">package.json · 812 B</div>
              <div className="mt-3 flex gap-2">
                <Chip tone="success">成功</Chip>
                <Chip>142 ms</Chip>
              </div>
            </div>
            <div className="rounded-card border border-accent/40 bg-accent-soft p-4 shadow-soft">
              <div className="text-small font-semibold text-accent">需要授权</div>
              <div className="mt-1 text-caption text-fg-muted">Shell 命令将写入工作空间外的目录</div>
              <div className="mt-3 flex gap-2">
                <Button size="sm">本会话允许</Button>
                <Button size="sm" variant="ghost">
                  拒绝
                </Button>
              </div>
            </div>
            <div className="rounded-card border border-line bg-surface p-4 shadow-soft">
              <div className="text-small font-semibold">会话用量</div>
              <div className="mt-2 font-num text-heading font-semibold">12,480</div>
              <div className="text-caption text-fg-subtle">tokens · 上下文余量 68%</div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-chip bg-surface-2">
                <div className="h-full w-[32%] rounded-chip bg-accent" />
              </div>
            </div>
          </div>
        </Section>

        <Section title="动效" desc="更活泼：进出场允许一次过冲/回弹，单次 ≤ 600ms；系统开启减弱动效时自动降级。">
          <div className="mb-4 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={replay}>
              重播全部
            </Button>
            <span className="self-center text-caption text-fg-subtle">点击后各示例会以对应动效再次进场</span>
          </div>
          <div key={motionKey} className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <MotionDemo label="fade-up" className="animate-fade-up" />
            <MotionDemo label="pop-in" className="animate-pop-in" />
            <MotionDemo label="slide-in-right" className="animate-slide-in-right" />
            <MotionDemo label="slide-in-left" className="animate-slide-in-left" />
            <MotionDemo label="bounce-in" className="animate-bounce-in" />
            <MotionDemo label="shake" className="animate-shake" />
            <MotionDemo label="wiggle" className="animate-wiggle" />
            <MotionDemo label="float（循环）" className="animate-float" />
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-field border border-line p-4">
              <div className="mb-2 text-caption text-fg-subtle">animate-breathe（运行中状态）</div>
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 animate-breathe rounded-chip bg-accent" />
                <span className="text-small text-fg-muted">模型正在生成…</span>
              </div>
            </div>
            <div className="rounded-field border border-line p-4">
              <div className="mb-2 text-caption text-fg-subtle">animate-shimmer（骨架屏）</div>
              <div
                className="h-4 animate-shimmer rounded-chip"
                style={{
                  backgroundImage: 'linear-gradient(90deg, var(--ui-surface-2), var(--ui-surface-3), var(--ui-surface-2))',
                  backgroundSize: '200% 100%',
                }}
              />
            </div>
          </div>
        </Section>

        <Section title="壳层提案" desc="决策：顶部只保留「市场」，其余入口收进「设置」；对话为默认主视图。">
          <ShellPreview />
        </Section>

        <Section title="设置面提案" desc="设置从顶部 tab 收进独立面：左侧按主题分组，右侧为具体配置。">
          <SettingsPreview />
        </Section>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- 子组件

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <div className="inline-flex items-center gap-1 rounded-field border border-line bg-surface-2 p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`rounded-[7px] px-2.5 py-1 text-caption transition duration-200 ease-standard ${
            option.value === value ? 'bg-surface text-fg shadow-soft' : 'text-fg-muted hover:text-fg'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function MotionDemo({ label, className }: { label: string; className: string }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className={`grid h-16 w-full place-items-center rounded-field bg-accent-soft text-caption font-medium text-accent ${className}`}>
        {label}
      </div>
    </div>
  )
}

function ShellPreview() {
  return (
    <div className="overflow-hidden rounded-panel border border-line bg-canvas shadow-pop">
      <div className="flex h-[460px]">
        {/* 侧栏 */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
          <div className="flex items-center justify-between px-3 py-3">
            <span className="text-small font-semibold tracking-wide">hu-agent</span>
            <span className="rounded-field bg-accent px-2 py-1 text-caption font-medium text-accent-contrast shadow-soft">新建会话</span>
          </div>
          <div className="px-3 pb-2">
            <div className="rounded-field border border-line bg-surface-2 px-2.5 py-1.5 text-caption text-fg-subtle">搜索会话…</div>
          </div>
          <div className="min-h-0 flex-1 space-y-1 px-2 py-1">
            <div className="rounded-field bg-accent-soft px-3 py-2 text-small font-medium text-accent">重构市场安装流程</div>
            <div className="rounded-field px-3 py-2 text-small text-fg-muted transition duration-200 ease-standard hover:bg-surface-2">
              排查同步冲突
            </div>
            <div className="rounded-field px-3 py-2 text-small text-fg-muted transition duration-200 ease-standard hover:bg-surface-2">
              写一份 Skill 说明
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-line p-3">
            <span className="grid h-6 w-6 place-items-center rounded-chip bg-surface-3 text-caption">陈</span>
            <span className="truncate text-caption text-fg-muted">chen@example.com</span>
          </div>
        </aside>

        {/* 主区 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
            <div className="flex items-center gap-1 rounded-field border border-line bg-surface-2 p-0.5">
              <span className="rounded-[7px] bg-surface px-2.5 py-1 text-caption font-medium shadow-soft">对话</span>
              <span className="px-2.5 py-1 text-caption text-fg-muted">市场</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="rounded-field border border-line px-2.5 py-1 text-caption text-fg-muted">默认工作空间 ▾</span>
              <span className="grid h-7 w-7 place-items-center rounded-chip bg-surface-2 text-caption" title="设置（模型/Skill/MCP/工作空间/云同步/用量/权限/关于）">
                ⚙
              </span>
            </div>
          </header>

          <div className="flex-1 space-y-3 overflow-hidden px-5 py-4">
            <div className="ml-auto w-fit max-w-[70%] animate-fade-up rounded-card rounded-br-md bg-accent px-3.5 py-2 text-small text-accent-contrast shadow-soft">
              帮我把同步冲突的处理流程整理成一页说明
            </div>
            <div className="w-fit max-w-[78%] animate-fade-up rounded-card rounded-bl-md border border-line bg-surface px-3.5 py-2 text-small shadow-soft">
              <div className="text-caption text-fg-subtle">正在读取 workspace 配置…</div>
              <div className="mt-1.5">我会按「检测 → 三选项 → 备份 → 覆盖」的顺序整理。</div>
            </div>
            <div className="w-fit max-w-[78%] animate-pop-in rounded-card border border-line bg-surface p-3 shadow-soft">
              <div className="flex items-center gap-2 text-small font-medium">
                <span className="h-1.5 w-1.5 animate-breathe rounded-chip bg-accent" />
                工具调用 · read_file
              </div>
              <div className="mt-1 font-num text-caption text-fg-subtle">sync/engine.ts · 6.1 KB</div>
            </div>
          </div>

          <div className="border-t border-line bg-surface p-3">
            <div className="flex items-end gap-2 rounded-card border border-line bg-surface-2 p-2">
              <div className="flex-1 px-1.5 py-1 text-small text-fg-subtle">输入消息，⌘/Ctrl + Enter 发送…</div>
              <span className="rounded-field bg-accent px-3 py-1.5 text-caption font-medium text-accent-contrast shadow-soft">发送</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingsPreview() {
  const groups = [
    { title: '工作区', items: ['模型配置', 'Skill 配置', 'MCP 配置', '工作空间'] },
    { title: '团队与云', items: ['市场', '云同步', '用量统计'] },
    { title: '系统', items: ['权限与审计', '关于'] },
  ]
  return (
    <div className="relative overflow-hidden rounded-panel border border-line bg-canvas p-6">
      <div className="mx-auto max-w-3xl overflow-hidden rounded-card border border-line bg-surface shadow-pop">
        <div className="border-b border-line px-5 py-3 text-title font-semibold">设置</div>
        <div className="flex min-h-[280px]">
          <div className="w-44 shrink-0 space-y-4 border-r border-line bg-surface-2 p-3">
            {groups.map((group) => (
              <div key={group.title}>
                <div className="mb-1 px-2 text-caption font-medium text-fg-subtle">{group.title}</div>
                {group.items.map((item) => (
                  <div
                    key={item}
                    className={`rounded-field px-2 py-1.5 text-small transition duration-200 ease-standard ${
                      item === '模型配置' ? 'bg-surface text-fg shadow-soft' : 'text-fg-muted hover:text-fg'
                    }`}
                  >
                    {item}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="flex-1 p-5">
            <div className="text-title font-medium">模型配置</div>
            <p className="mt-1 text-caption text-fg-subtle">
              只展示示意结构；实际内容沿用现有 ModelSection 功能，迁移到新令牌体系。
            </p>
            <div className="mt-4 space-y-3">
              <Field label="模型目录" placeholder="~/.hu-agent/models.json" />
              <Field label="默认模型" placeholder="deepseek-v4.1-flash" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
