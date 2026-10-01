export class InvalidCursorError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidCursorError";
    this.statusCode = 400;
  }
}

export function encodeCursor(id) {
  return Buffer.from(String(id), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  try {
    return Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCursorError("cursor is not valid base64url");
  }
}

/**
 * Paginate an array by opaque cursor.
 *
 * @param {Array<{id: string}>} list - items ordered the same way every time (e.g. by creation order)
 * @param {{cursor?: string, limit?: number}} query
 * @returns {{ items: any[], next_cursor: string|null }}
 */
export function paginate(list, { cursor, limit = 20 } = {}) {
  let startIndex = 0;

  if (cursor) {
    const lastId = decodeCursor(cursor);
    const idx = list.findIndex((item) => item.id === lastId);
    if (idx === -1) {
      throw new InvalidCursorError("cursor does not match any known item");
    }
    startIndex = idx + 1;
  }

  const page = list.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < list.length;
  const next_cursor =
    hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].id) : null;

  return { items: page, next_cursor };
}
