/**
 * 玻璃下拉选择（零依赖）：替代原生 `<select>`。
 *
 * 为什么需要：原生 select 的弹出层由系统绘制，深色主题下会出现白底浅字（不可读，2026-10-15 实测）。
 * 这里用玻璃面板 + 键盘可用（Esc/↑↓/Enter，焦点回到选项）实现，外观与应用一致。
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

export interface GlassSelectOption {
  value: string
  label: string
}

interface Props {
  value: string
  options: GlassSelectOption[]
  onChange: (value: string) => void
  title?: string
  disabled?: boolean
  /** 弹层方向：底部的选择器用 up，顶部/中部用 down（默认） */
  placement?: 'up' | 'down'
  className?: string
  /** 小尺寸（用于紧凑工具条） */
  small?: boolean
}

export default function GlassSelect({
  value,
  options,
  onChange,
  title,
  disabled = false,
  placement = 'down',
  className = '',
  small = false,
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const current = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 展开后把焦点放到当前项（键盘可达）
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const active = list?.querySelector<HTMLButtonElement>('[data-active="true"]') ?? list?.querySelector('button')
    active?.focus()
  }, [open])

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const index = buttons.findIndex((button) => button === document.activeElement)
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1) : Math.max(index - 1, 0)
    buttons[next]?.focus()
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className={`ui-btn ui-btn-glass flex w-full items-center justify-between gap-2 ${
          small ? 'px-3 py-1.5 text-caption' : 'px-3.5 py-2 text-small'
        } disabled:cursor-not-allowed disabled:opacity-40`}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <span className={`text-[9px] transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          onKeyDown={onListKeyDown}
          className={`glass absolute left-0 z-40 max-h-64 min-w-full animate-pop-in overflow-y-auto rounded-field p-1 ${
            placement === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
          }`}
        >
          {options.map((option) => {
            const selected = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                data-active={selected}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                className={`flex w-full items-center gap-2 rounded-[10px] px-3 py-1.5 text-left text-caption transition duration-150 ease-standard ${
                  selected ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`}
              >
                <span className="flex-1 truncate">{option.label}</span>
                {selected && <span className="text-[10px]">✓</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
