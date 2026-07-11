import {
  ApiError,
  isOpenAIQuotaError,
  OPENAI_BILLING_URL,
} from "./api";
import { fireToast } from "./toast";

const QUOTA_HELP =
  "ChatGPT Plus does not include API credits. Add billing to the OpenAI Platform account that created this API key, then retry.";

export function showOpenAIQuotaToast(err: unknown): boolean {
  if (!isOpenAIQuotaError(err)) return false;

  const billingUrl = err.billingUrl || OPENAI_BILLING_URL;
  fireToast({
    kind: "error",
    title: "OpenAI API credits unavailable",
    body: QUOTA_HELP,
    durationMs: 12_000,
    action: {
      label: "Open API billing",
      onClick: () => {
        const popup = window.open(billingUrl, "_blank", "noopener,noreferrer");
        if (popup) popup.opener = null;
      },
    },
  });
  return true;
}

export function userFacingOpenAIError(err: unknown): string {
  return err instanceof ApiError ? err.message : String(err);
}
