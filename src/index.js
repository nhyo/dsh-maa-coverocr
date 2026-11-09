// DSH plugin entry: provides the `maaCoverocr` service to dsh-maa-cli.
// The OCR models are loaded on first use, never at startup.
import { createCoverocrService, SERVICE_NAME } from './service.js'

export const name = 'maa-coverocr'

export function apply(ctx) {
  ctx.provide(SERVICE_NAME, createCoverocrService())
}

export { API_VERSION, createCoverocrService, SERVICE_NAME } from './service.js'
