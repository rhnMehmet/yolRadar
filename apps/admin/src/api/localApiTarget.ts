export const API_TARGETS = [
  { origin:'http://127.0.0.1:8001', label:'Mevcut analiz alanı · 8001' },
  { origin:'http://127.0.0.1:8002', label:'İnceleme TEST alanı · 8002' },
] as const
export type ApiTarget = typeof API_TARGETS[number]['origin']
export function localApiTarget(value: string): ApiTarget {
  if (!API_TARGETS.some(t=>t.origin===value)) throw new Error('Yalnız izinli yerel API hedefleri kullanılabilir.')
  return value as ApiTarget
}
