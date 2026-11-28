import { expect, test } from "bun:test";
import { driveBrowser } from "../../src/server/object-storage/browser-drive.js";
import { parseS3List } from "../../src/server/object-storage/s3-list.js";

test("S3 directory lists decode object names, skip folder markers and retain the provider cursor", () => {
  const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <EncodingType>url</EncodingType><IsTruncated>true</IsTruncated><NextContinuationToken>a+/=</NextContinuationToken>
    <Contents><Key>scope%2F</Key><Size>0</Size></Contents>
    <CommonPrefixes><Prefix>scope%2F%E5%9C%96%E7%89%87%2F</Prefix></CommonPrefixes>
    <Contents><Key>scope%2Ftest+%25%2B.png</Key><Size>27</Size><LastModified>2026-11-28T00:00:00Z</LastModified></Contents>
    <Contents><Key>scope%2F..%2Fprivate</Key><Size>99</Size></Contents>
  </ListBucketResult>`;
  const buffer = new TextEncoder().encode(xml);
  const page = parseS3List(buffer, "scope/");
  expect(page.next).toBe("a+/=");
  expect(page.entries).toEqual([
    { id: "scope/圖片/", name: "圖片", kind: "folder" },
    {
      id: "scope/test %+.png",
      name: "test %+.png",
      kind: "file",
      bytes: 27,
      modified: "2026-11-28T00:00:00Z",
      download: true,
    },
  ]);
  expect(() => parseS3List(buffer, "different/")).toThrow("storageIntegrity");
});

test("Drive refreshes authorized access server-side and lists, opens and downloads the permitted files", async () => {
  const calls: URL[] = [];
  const send = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.host === "oauth2.googleapis.com") {
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return Response.json({ access_token: "fixtureToken" });
    }
    expect(url.host).toBe("www.googleapis.com");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixtureToken");
    if (url.searchParams.get("alt") === "media") return new Response("fixture bytes");
    if (url.pathname.endsWith("/archive"))
      return Response.json({
        name: "Campaign",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root"],
      });
    if (url.pathname.endsWith("/file1")) return Response.json({ name: "Guide.pdf", mimeType: "application/pdf" });
    if (url.pathname.endsWith("/missing")) return Response.json({}, { status: 404 });
    expect(url.searchParams.get("q")).toBe("'archive' in parents and trashed = false");
    expect(url.searchParams.get("pageToken")).toBe("page-one");
    return Response.json({
      nextPageToken: "page-two",
      files: [
        { id: "nested", name: "Nested", mimeType: "application/vnd.google-apps.folder" },
        {
          id: "file1",
          name: "Guide.pdf",
          mimeType: "application/pdf",
          size: "13",
          capabilities: { canDownload: true },
        },
        {
          id: "doc1",
          name: "Storyboard",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://docs.google.com/document/d/doc1/edit",
        },
        {
          id: "bad",
          name: "Unsafe",
          mimeType: "application/vnd.google-apps.document",
          webViewLink: "https://example.com/document",
        },
      ],
    });
  }) as typeof fetch;
  const drive = await driveBrowser(
    { clientId: "fixtureId", clientSecret: "fixtureSecret", refreshToken: "fixtureRefresh" },
    send,
  );
  const page = await drive.list("archive", "page-one");
  expect(page.path).toEqual([{ id: "archive", name: "Campaign" }]);
  expect(page.next).toBe("page-two");
  expect(page.entries.map((row) => [row.name, row.kind, row.download, row.openUrl])).toEqual([
    ["Nested", "folder", undefined, undefined],
    ["Guide.pdf", "file", true, undefined],
    ["Storyboard", "file", undefined, "https://docs.google.com/document/d/doc1/edit"],
    ["Unsafe", "file", undefined, undefined],
  ]);
  const result = await drive.download("file1", AbortSignal.timeout(1000));
  expect(result.name).toBe("Guide.pdf");
  expect(await result.response.text()).toBe("fixture bytes");
  await expect(drive.download("missing", AbortSignal.timeout(1000))).rejects.toThrow("missing");
  await expect(drive.download("../archive", AbortSignal.timeout(1000))).rejects.toThrow("invalidPath");
  expect(calls.filter((url) => url.host === "oauth2.googleapis.com")).toHaveLength(1);
});
