/** ULID：时间有序 ID（design 5.3 会话 ID 约定），无第三方依赖。 */

import { randomBytes } from 'node:crypto'

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16

let lastTime = 0
let lastRandom: number[] = []

function encodeTime(time: number): string {
  let value = time
  const out = new Array<string>(TIME_LENGTH)
  for (let i = TIME_LENGTH - 1; i >= 0; i -= 1) {
    out[i] = ENCODING[value % 32]
    value = Math.floor(value / 32)
  }
  return out.join('')
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LENGTH)
  return Array.from(bytes, (byte) => byte % 32)
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    // 同毫秒内递增，保证单调
    for (let i = lastRandom.length - 1; i >= 0; i -= 1) {
      if (lastRandom[i] < 31) {
        lastRandom[i] += 1
        break
      }
      lastRandom[i] = 0
    }
  } else {
    lastTime = now
    lastRandom = randomChars()
  }
  return encodeTime(now) + lastRandom.map((value) => ENCODING[value]).join('')
}
