---
title: Work with projects and conversations
---

Create a project with a name, unique code and optional description. Start a conversation inside it, or associate an existing conversation. Projects and native sessions are separate: moving a conversation does not move files or rewrite native history.

Select a working folder before submitting a new conversation. Type an instruction, attach files or paste an image. Wait until attachments are ready. Limits are ten files per message and 25 MiB per file. Browser-provided filenames are preserved; clipboard images can have generic names.

Read command/file approvals before responding. Requests also appear in the pending-request inbox. Failed responses remain available for retry. Questionnaires support multiple questions, per-question single choice, permitted custom text and masked private answers. Same-question multi-select is not implemented.

The preparation screen reports actual reads. Retry a failed step instead of repeatedly reopening large histories. Only public reasoning summaries supplied by the engine can be shown.

The file browser and terminal use the server's OS privileges. Review currently applies Undo/Reapply to the aggregated diff, not individual hunks. Treat the workspace as shared with every admitted user.

## Session information and tools

On a desktop, the **Session** panel sits beside the conversation. Its overview shows session usage above execution status, followed by project association, the working folder and configuration. Close it for more conversation space; use **Session information** in the header to reopen it. **Goal & plan** expands the session's Goal details when available. The **Session actions** menu lets you rename the session, copy its marker and change the theme.

Click the project to search by name or code and change its association. The working folder is displayed separately and does not change when you associate a different project.

Open model/reasoning or permissions, select the desired values, then choose **Save changes**. **Cancel** discards the edits. Settings apply to the next instruction in the current session. Desktop dialogs appear in the center of the viewport, with the title and action buttons remaining visible when the content scrolls. Full access still requires a separate confirmation; managed permission options can be unavailable.

Session usage separates cumulative input/output tokens from the latest context occupancy. Cached input is already included in input tokens. A missing engine report appears as a dash or an unavailable message; it is not assumed to be zero. Existing usage is restored from native history when a session is opened or refreshed, then updated by live engine reports. Compact numbers in the side panel show precise values on hover or in the usage dialog. Account quota, when supported by the provider, remains available through the account menu.

The **Tools** tab provides files, changes, terminal, browser and side tasks. Search tools, enable the checklist, and pin or reorder up to three shortcuts using **Manage tools**. Session notes and checklists are saved in this browser for the current login and session; they are not submitted as assistant instructions or synchronized between devices.

On a phone, use the compact permission and model icons beside attachment, queue and send. Settings, session information and usage open in bottom sheets. The session page uses the upper-left navigation drawer to leave room for the composer. Approvals and questionnaires stay in the conversation; **Review in conversation** returns to the pending request. Submitting a questionnaire sends its answers directly while preserving an unrelated composer draft and its attachments.

## Find a conversation

Expand **Unassigned sessions** in the sidebar. **Recent** shows at most the latest ten. Switch to **Folders**, then expand a working folder to browse its older conversations. Click the same folder to collapse it; the arrow keys also move between folders and expand or collapse them. The folder name is followed by its path; hover to see the complete path when it is shortened. The directory entry stays available even when all recently loaded conversations have already been assigned to projects.

A project's conversation list supports text search combined with a working-directory filter. **Link existing sessions** provides the same combination across native history, with pagination. Selected conversations remain selected when you change the search or directory, until you submit or close the dialog. Associating a conversation updates the unassigned directory count and does not move its working files.
