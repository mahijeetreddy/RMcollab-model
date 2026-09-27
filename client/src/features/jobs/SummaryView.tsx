import { useMemo } from "react";
import { parseMarkdown, type Inline } from "../../lib/markdown";

function InlineContent({ content }: { content: Inline[] }) {
  return (
    <>
      {content.map((part, index) =>
        part.kind === "strong" ? (
          <strong key={index}>{part.text}</strong>
        ) : part.kind === "em" ? (
          <em key={index}>{part.text}</em>
        ) : part.kind === "code" ? (
          <code key={index}>{part.text}</code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

// The room is h2 and a job card sits below it, so a summary's own sections start at h4.
const HEADING_TAG = { 1: "h4", 2: "h5", 3: "h6" } as const;

/** Renders a model-written summary as React elements; see lib/markdown for why not HTML. */
export function SummaryView({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return <p className="empty">The summary is empty.</p>;

  return (
    <div className="summary">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const Tag = HEADING_TAG[block.level];
          return (
            <Tag key={index}>
              <InlineContent content={block.content} />
            </Tag>
          );
        }
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index}>
              {block.items.map((item, i) => (
                <li key={i}>
                  <InlineContent content={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={index}>
            <InlineContent content={block.content} />
          </p>
        );
      })}
    </div>
  );
}
