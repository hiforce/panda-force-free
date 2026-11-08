---
title: Work with projects and conversations
---

Create a project with a name, unique code and optional description. Start a conversation inside it, or associate an existing conversation. Projects and native sessions are separate: moving a conversation does not move files or rewrite native history.

PandaForce 0.0.15 and later creates a real folder named after the project code under `PANDA_FORCE_PROJECTS_ROOT`. New conversations inside that project use its folder automatically. The code becomes fixed once bound to a folder; the display name and description remain editable. Linking a historical conversation keeps its original working folder and native history.

For an unassigned conversation, select a working folder before submitting. Type an instruction, attach files or paste an image. Wait until attachments are ready. Limits are ten files per message and 25 MiB per file. Browser-provided filenames are preserved; clipboard images can have generic names.

Read command/file approvals before responding. Requests also appear in the pending-request inbox. Failed responses remain available for retry. Questionnaires support multiple questions, per-question single choice, permitted custom text and masked private answers. Same-question multi-select is not implemented.

The preparation screen reports actual reads. Retry a failed step instead of repeatedly reopening large histories. Only public reasoning summaries supplied by the engine can be shown.

The file browser and terminal use the server's OS privileges. Review currently applies Undo/Reapply to the aggregated diff, not individual hunks. Treat the workspace as shared with every admitted user.

## Customize your workspace

The top navigation contains global search, **Language**, **Appearance**, **Layout**, browser full screen and your profile. On a phone, open **Workspace preferences** for language, appearance, layout and profile settings. Global preferences are separate from the current session's title and actions.

Choose **Light** for white surfaces, **Graphite** for a neutral dark workspace, **Silk** for warm surfaces or **Aurora** for cool dark surfaces. **System default** follows your device. The top navigation and the Appearance settings page share the same preference.

On a desktop, **Layout** offers **Comfortable** (up to 800 px), **Wide** (up to 1,040 px) and **Fill available space**. The title, messages and composer stay aligned within the space between the side panels. Width and desktop sidebar choices persist in this browser. **Focus mode** temporarily hides the panels and restores their previous visibility when you exit; it does not replace your saved choices. Browser full screen is independent and is available only when supported by the browser.

Desktop preferences open beside their toolbar button. On a phone they open as bottom sheets. Press Escape or use Close to dismiss a menu and return focus to its trigger. Changing preferences preserves the current draft. Narrow desktop and tablet layouts use an overlay for session details; phones keep the attachment, permission, model, queue and send controls in a compact row.

## Session information and tools

On a desktop, the **Session** panel sits beside the conversation. Its overview shows session usage above execution status, followed by project association, the working folder and configuration. Close it for more conversation space; use the details button beside the session title to reopen it. **Goal & plan** expands the session's Goal details when available. The **Session actions** menu lets you rename the session and copy its marker.

Click the project to search by name or code and change its association. The working folder is displayed separately and does not change when you associate a different project.

Open model/reasoning or permissions, select the desired values, then choose **Save changes**. **Cancel** discards the edits. Settings apply to the next instruction in the current session. Desktop dialogs appear in the center of the viewport, with the title and action buttons remaining visible when the content scrolls. Full access still requires a separate confirmation; managed permission options can be unavailable.

Session usage separates cumulative input/output tokens from the latest context occupancy. Cached input is already included in input tokens. A missing engine report appears as a dash or an unavailable message; it is not assumed to be zero. Existing usage is restored from native history when a session is opened or refreshed, then updated by live engine reports. Compact numbers in the side panel show precise values on hover or in the usage dialog. Account quota, when supported by the provider, remains available through the account menu.

The **Tools** tab provides files, changes, terminal, browser and side tasks. Search tools, enable the checklist, and pin or reorder up to three shortcuts using **Manage tools**. Session notes and checklists are saved in this browser for the current login and session; they are not submitted as assistant instructions or synchronized between devices.

On a phone, use the compact permission and model icons beside attachment, queue and send. Settings, session information and usage open in bottom sheets. The session page uses the upper-left navigation drawer to leave room for the composer. Approvals and questionnaires stay in the conversation; **Review in conversation** returns to the pending request. Submitting a questionnaire sends its answers directly while preserving an unrelated composer draft and its attachments.

## Find a conversation

Expand **Unassigned sessions** in the sidebar. **Recent** shows at most the latest ten. Switch to **Folders**, then expand a working folder to browse its older conversations. Click the same folder to collapse it; the arrow keys also move between folders and expand or collapse them. The folder name is followed by its path; hover to see the complete path when it is shortened. The directory entry stays available even when all recently loaded conversations have already been assigned to projects.

A project's conversation list supports text search combined with a working-directory filter. **Link existing sessions** provides the same combination across native history, with pagination. Selected conversations remain selected when you change the search or directory, until you submit or close the dialog. Associating a conversation updates the unassigned directory count and does not move its working files.


## Follow the latest messages

Sending a new message returns the conversation to the bottom. While you are following
the latest content, delayed image loading or a layout change keeps the newest content
visible. Scroll upward to read history without being pulled back; use the down-arrow
button to resume following the conversation.
