import { Injectable, Logger } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { CateringDaglijstTemplate } from './templates/catering-daglijst-template';
import type { DaglijstPayload } from './daglijst.service';

/**
 * Compile a Daglijst payload into a PDF buffer using @react-pdf/renderer.
 *
 * Sprint 2 ships only the catering NL template. AV / supplies templates
 * (different page layout) land later when those service types graduate
 * past the catering Tier-1 baseline.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §5.
 */
@Injectable()
export class PdfRendererService {
  private readonly log = new Logger(PdfRendererService.name);

  async renderDaglijst(input: RenderInput): Promise<RenderResult> {
    const startedAt = Date.now();
    // Sprint 2 only catering. Switching by service_type when AV/supplies
    // ship — keep the dispatch table here, not in DaglijstService.
    const element = CateringDaglijstTemplate({
      payload: input.payload,
      generation: input.generation,
    });

    const buffer = await renderToBuffer(element);
    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs > 3000) {
      // Spec §13 budgets <3s/PDF. Warn if we drift; investigation queue.
      this.log.warn(
        `daglijst render slow: tenant=${input.payload.tenant_id} ` +
        `vendor=${input.payload.vendor.id} elapsed_ms=${elapsedMs}`,
      );
    }

    return {
      buffer,
      mimeType: 'application/pdf',
      sizeBytes: buffer.length,
      renderMs: elapsedMs,
    };
  }
}

export interface RenderInput {
  payload: DaglijstPayload;
  generation: {
    version: number;
    generated_at: string;
    triggered_by: 'auto' | 'admin_manual';
  };
}

export interface RenderResult {
  buffer: Buffer;
  mimeType: 'application/pdf';
  sizeBytes: number;
  renderMs: number;
}
