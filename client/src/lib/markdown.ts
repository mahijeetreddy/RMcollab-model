// Moved to the shared package: the gateway parses summaries with the same code
// when it writes them into the room's notes. Re-exported so imports stay put.
export { parseInline, parseMarkdown, type Block, type Inline } from "@rmcollab/shared";
