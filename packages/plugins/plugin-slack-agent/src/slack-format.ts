const MAX_BLOCK_TEXT_LENGTH = 2900;
const MAX_BLOCKS = 20;

function convertMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]\n]+)]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");
}

function convertBold(text: string): string {
  return text.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, "*$1*");
}

function convertBullets(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*[-*]\s+/, "• "))
    .join("\n");
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markdownToSlackMrkdwn(markdown: string): string {
  const fencedBlocks: string[] = [];
  const tokenized = markdown.replace(/```[\s\S]*?```/g, (block) => {
    const token = `@@SLACK_CODE_BLOCK_${fencedBlocks.length}@@`;
    fencedBlocks.push(block);
    return token;
  });

  const converted = normalizeWhitespace(
    convertBullets(convertBold(convertMarkdownLinks(tokenized))),
  );

  return fencedBlocks.reduce(
    (text, block, index) => text.replace(`@@SLACK_CODE_BLOCK_${index}@@`, block),
    converted,
  );
}

function splitIntoBlockTexts(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const blocks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > MAX_BLOCK_TEXT_LENGTH) {
      if (current) {
        blocks.push(current);
        current = "";
      }
      for (let index = 0; index < paragraph.length; index += MAX_BLOCK_TEXT_LENGTH) {
        blocks.push(paragraph.slice(index, index + MAX_BLOCK_TEXT_LENGTH));
      }
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > MAX_BLOCK_TEXT_LENGTH) {
      blocks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current) blocks.push(current);
  return blocks.slice(0, MAX_BLOCKS);
}

export function buildSlackMessagePayload(markdown: string): { text: string; blocks: Array<Record<string, unknown>> } {
  const text = markdownToSlackMrkdwn(markdown);
  const blockTexts = splitIntoBlockTexts(text);
  return {
    text,
    blocks: blockTexts.map((blockText) => ({
      type: "section",
      text: {
        type: "mrkdwn",
        text: blockText,
      },
    })),
  };
}
