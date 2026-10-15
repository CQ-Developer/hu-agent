/**
 * 液态玻璃元素交互（用户澄清：只做元素级玻璃，不做满屏背景、不做鼠标光环）。
 *
 * - 点击涟漪：`.ui-btn` 在 pointerdown 注入一圈高光
 * - 不做磁吸/指针跟随高光：按钮悬停移位会导致点击丢失（2026-10-15 实测）
 * - `prefers-reduced-motion` 时跳过
 */

import { useEffect } from 'react'

const REDUCED_MOTION = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches

export function useGlassEffects(): void {
  useEffect(() => {
    if (REDUCED_MOTION()) return

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

    document.addEventListener('pointerdown', onPointerDown, { passive: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [])
}
