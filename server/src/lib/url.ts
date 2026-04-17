// Encode a `/`-separated folder path segment-by-segment so `#`, `?`, and
// other reserved characters get escaped but the `/` separators stay intact.
// Used by /media/... URL builders in both the HTTP route layer and the
// webhook payload builder — keeping a single source of truth so changes to
// path semantics only have to land in one place.
export function encodeFolderPath(folder: string): string {
  return folder.split("/").map(encodeURIComponent).join("/");
}
