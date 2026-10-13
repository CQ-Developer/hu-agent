import { useState } from 'react'

interface Props {
  running: boolean
  onSend: (text: string) => void
  onStop: () => void
}

export default function Composer({ running, onSend, onStop }: Props) {
  const [text, setText] = useState('')

  const submit = (): void => {
    const value = text.trim()
    if (!value || running) return
    onSend(value)
    setText('')
  }

  return (
    <div className="border-t border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder="描述你的任务…（Enter 发送，Shift+Enter 换行）"
          className="min-h-[64px] flex-1 resize-none rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
          >
            停止
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
