/// <reference types="vitest/config" />
import { createRequire } from 'node:module'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// 개발 서버 전용 /api/assistant: 배포 때 쓰는 Vercel 함수(api/assistant.ts)와 같은 공용 로직(server/assistant.ts)을 돈다.
// 키는 app/.env.local의 서버 전용 값(VITE_ 아님)에서 읽어 브라우저로 보내지 않는다.
function devAssistant(mode: string): Plugin {
  return {
    name: 'dev-assistant',
    apply: 'serve',
    configureServer(server) {
      const env = loadEnv(mode, import.meta.dirname, '')
      const shared = path.resolve(import.meta.dirname, 'server/assistant.ts')
      server.middlewares.use('/api/assistant', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end()
          return
        }
        let raw = ''
        req.on('data', (c) => (raw += c))
        req.on('end', async () => {
          let body: unknown = null
          try {
            body = JSON.parse(raw)
          } catch {
            // handleAssistant가 bad_request로 답한다
          }
          const mod = (await server.ssrLoadModule(shared)) as {
            handleAssistant: (b: unknown, e: Record<string, string | undefined>) => Promise<{ status: number; json: unknown }>
          }
          const out = await mod.handleAssistant(body, {
            bazeKey: env.BAZE_API_KEY,
            bazeBase: env.BAZE_BASE_URL,
            model: env.BAZE_MODEL,
            kakaoRestKey: env.KAKAO_REST_KEY,
          })
          res.statusCode = out.status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(out.json))
        })
      })
      // 공개 API (배포: api/features.ts, api/health.ts와 같은 server/publicApi.ts)
      const publicApi = path.resolve(import.meta.dirname, 'server/publicApi.ts')
      type Out = { status: number; json: unknown; headers?: Record<string, string> }
      type Mod = {
        apiEnv: (e: Record<string, string | undefined>) => unknown
        handleFeatures: (q: URLSearchParams, e: unknown) => Promise<Out>
        handleHealth: (e: unknown) => Promise<Out>
      }
      for (const route of ['/api/features', '/api/health'] as const) {
        server.middlewares.use(route, async (req, res) => {
          const mod = (await server.ssrLoadModule(publicApi)) as Mod
          const q = new URL(req.url ?? '/', 'http://local').searchParams
          const out = route === '/api/features' ? await mod.handleFeatures(q, mod.apiEnv(env)) : await mod.handleHealth(mod.apiEnv(env))
          res.statusCode = out.status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v)
          res.end(JSON.stringify(out.json))
        })
      }
      // 음성 → 글자 (배포: api/stt.ts와 같은 server/stt.ts). 녹음 바이트를 그대로 모아 넘긴다
      const stt = path.resolve(import.meta.dirname, 'server/stt.ts')
      type SttMod = {
        handleSttSubmit: (b: Uint8Array, ct: string | undefined, e: unknown) => Promise<Out>
        handleSttPoll: (op: string | null, e: unknown) => Promise<Out>
        sttEnv: (e: Record<string, string | undefined>, ffmpeg: string | null) => unknown
      }
      server.middlewares.use('/api/stt', async (req, res) => {
        const mod = (await server.ssrLoadModule(stt)) as SttMod
        const send = (out: Out) => {
          res.statusCode = out.status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(out.json))
        }
        if (req.method === 'GET') return send(await mod.handleSttPoll(new URL(req.url ?? '/', 'http://local').searchParams.get('op'), mod.sttEnv(env, null)))
        if (req.method !== 'POST') return send({ status: 405, json: { error: 'method_not_allowed' } })
        const chunks: Buffer[] = []
        let size = 0
        req.on('data', (c: Buffer) => {
          size += c.length
          if (size <= 3_000_000) chunks.push(c)
        })
        req.on('end', async () => {
          const ffmpeg = createRequire(import.meta.url)('ffmpeg-static') as string | null
          send(await mod.handleSttSubmit(new Uint8Array(Buffer.concat(chunks)), req.headers['content-type'], mod.sttEnv(env, ffmpeg)))
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  return {
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      devAssistant(mode),
      VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['favicon.svg'],
          manifest: {
            name: '동해 무장애지도',
            short_name: '무장애지도',
            description: '조사단이 직접 걷고 잰 동해시 보행 접근성 지도',
            lang: 'ko',
            start_url: '/',
            display: 'standalone',
            background_color: '#f5f5f5',
            theme_color: '#f5f5f5',
            icons: [{ src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
          },
        }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      // 같은 와이파이의 폰에서 열어볼 수 있게 한다. 센서·위치는 HTTPS가 필요하므로 실기기 테스트는 Vercel 미리보기 주소로 한다
      host: true,
    },
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
    },
  }
})
