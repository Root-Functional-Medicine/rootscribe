import { Factory } from "fishery";
import type { ContentListItem, FileDetailData } from "../plaud/detail.js";

// Factory for the Plaud /file/detail endpoint data shape. The detail.test
// suite exercises branches driven by `content_list` shape — presence of
// transcription entries, summary entries, task status variants. Traits
// model the ones actually under test.

interface FileDetailDataTransient {
  contentItems?: ContentListItem[];
}

const transcriptItem: ContentListItem = {
  data_id: "t1",
  data_type: "transaction",
  task_status: 2,
  err_code: "",
  err_msg: "",
  data_title: "Transcript",
  data_tab_name: "trans",
  data_link: "https://s3.example/t1.json",
};

const summaryItem: ContentListItem = {
  data_id: "s1",
  data_type: "auto_sum_note",
  task_status: 2,
  err_code: "",
  err_msg: "",
  data_title: "Summary",
  data_tab_name: "sum",
  data_link: "https://s3.example/s1.md",
};

class FileDetailDataFactory extends Factory<
  FileDetailData,
  FileDetailDataTransient
> {
  withTranscriptItem(item: Partial<ContentListItem> = {}): this {
    return this.transient({
      contentItems: [{ ...transcriptItem, ...item }],
    }) as this;
  }

  withSummaryItem(item: Partial<ContentListItem> = {}): this {
    return this.transient({
      contentItems: [{ ...summaryItem, ...item }],
    }) as this;
  }

  withContentItems(...contentItems: ContentListItem[]): this {
    return this.transient({ contentItems }) as this;
  }

  trashed(): this {
    return this.params({ is_trash: true }) as this;
  }
}

export const fileDetailDataFactory = FileDetailDataFactory.define(
  ({ transientParams }) => ({
    file_id: "abc123",
    file_name: "2026-04-18 meeting",
    file_version: 1,
    duration: 120,
    is_trash: false,
    start_time: 1_775_000_000_000,
    scene: 0,
    serial_number: "SN-001",
    session_id: 42,
    filetag_id_list: [],
    content_list: transientParams.contentItems ?? [transcriptItem],
    embeddings: {},
    download_path_mapping: {},
    pre_download_content_list: [],
    extra_data: null,
    has_thought_partner: false,
  }),
);

export { transcriptItem as defaultTranscriptContentItem };
export { summaryItem as defaultSummaryContentItem };
