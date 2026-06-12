import { AdapterContext, isRecord } from "../adapter-context.ts";
import type { Adapter } from "../types.ts";

export const f3ResponsesAdapter: Adapter = {
  id: "f3",
  normalize(frames) {
    const ctx = new AdapterContext(frames);
    for (const frame of frames) {
      if (frame.comment || frame.done) {
        ctx.drop(frame, frame.done ? "done_sentinel" : "sse_comment");
      } else if (frame.parseError || !isRecord(frame.data)) {
        ctx.diagnostic(frame, "parse_error", frame.parseError ?? frame.dataRaw);
      } else {
        // TODO: implement SPEC section 6 F3 Responses mapping and section 3.5 incomplete dispatch.
        ctx.diagnostic(frame, "unsupported_frame", frame.data);
      }
    }
    ctx.emit(undefined, "lifecycle", {
      phase: "error",
      reason: "error",
      status: "incomplete",
      diagnostic: { code: "adapter_stub", detail: "F3 Responses adapter not implemented" }
    });
    return ctx.result();
  }
};
