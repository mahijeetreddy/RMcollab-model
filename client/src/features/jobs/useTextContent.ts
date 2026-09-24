import { useEffect, useState } from "react";
import { api } from "../../api/client";

export interface TextContent {
  value: string | null;
  error: string | null;
  loading: boolean;
}

/** Text media is stored as a blob under /files, so the panes have to fetch it. */
export function useTextContent(url: string | null, enabled: boolean): TextContent {
  const [state, setState] = useState<TextContent>({ value: null, error: null, loading: false });

  useEffect(() => {
    if (!url || !enabled) {
      setState({ value: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ value: null, error: null, loading: true });
    api
      .fetchTextBlob(url)
      .then((value) => {
        if (!cancelled) setState({ value, error: null, loading: false });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            value: null,
            error: cause instanceof Error ? cause.message : "Could not load text",
            loading: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url, enabled]);

  return state;
}
