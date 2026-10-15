/**
 * 液态玻璃元素交互（用户澄清：只做元素级玻璃，不做满屏背景）。
 *
 * - 指针跟随高光：`.glass` 元素写入 `--mx/--my`
 * - 磁吸按钮：`.ui-btn` 跟随指针轻微位移，离开复位
 * - 点击涟漪：`.ui-btn` 在 pointerdown 注入一圈高光
 * - `prefers-reduced-motion` 时全部跳过
 */

import { useEffect } from 'react'

const REDUCED_MOTION = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

export function useGlassEffects(): void {
  useEffect(() => {
    if (REDUCED_MOTION()) return

    const onPointerMove = (event: PointerEvent): void => {
      const target = (event.target as HTMLElement | null)?.closest?.('.glass')
      if (target instanceof HTMLElement) {
        const rect = target.getBoundingClientRect()
        target.style.setProperty('--mx', `${((event.clientX - rect.left) / rect.width) * 100}%`)
        target.style.setProperty('--my', `${((event.clientY - rect.top) / rect.height) * 100}%`)
      }
      const button = (event.target as HTMLElement | null)?.closest?.('.ui-btn')
      if (button instanceof HTMLElement) {
        const rect = button.getBoundingClientRect()
        const dx = event.clientX - (rect.left + rect.width / 2)
        const dy = event.clientY - (rect.top + rect.height / 2)
        button.style.setProperty('--tx', `${(dx * 0.3).toFixed(1)}px`)
        button.style.setProperty('--ty', `${(dy * 0.42).toFixed(1)}px`)
      }
    }

    const onPointerOut = (event: PointerEvent): void => {
      const button = (event.target as HTMLElement | null)?.closest?.('.ui-btn')
      if (!(button instanceof HTMLElement)) return
      const related = event.relatedTarget as Node | null
      if (related && button.contains(related)) return
      button.style.setProperty('--tx', '0px')
      button.style.setProperty('--ty', '0px')
    }

    const onPointerDown = (event: PointerEvent): void => {
      const button = (event.target as HTMLElement | null)?.closest?.('.ui-btn')
      if (!(button instanceof HTMLElement)) return
      const rect = button.getBoundingClientRect()
      const size = Math.max(rect.width, rect.height) * 2.2
      const ripple = document.createElement('span')
      ripple.className = 'ui-ripple'
      ripple.style.width = `${size}px`
      ripple.style.height = `${size}px`
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`
      button.appendChild(ripple)
      ripple.addEventListener('animationend', () => ripple.remove())
    }

    document.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerout', onPointerOut, { passive: true })
    document.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])
}
