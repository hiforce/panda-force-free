---
title: Work with projects and conversations
---

Create a project with a name, unique code and optional description. Start a conversation inside it, or associate an existing conversation. Projects and native sessions are separate: moving a conversation does not move files or rewrite native history.

Select a working folder before submitting a new conversation. Type an instruction, attach files or paste an image. Wait until attachments are ready. Limits are ten files per message and 25 MiB per file. Browser-provided filenames are preserved; clipboard images can have generic names.

Read command/file approvals before responding. Requests also appear in the pending-request inbox. Failed responses remain available for retry. Questionnaires support multiple questions, per-question single choice, permitted custom text and masked private answers. Same-question multi-select is not implemented.

The preparation screen reports actual reads. Retry a failed step instead of repeatedly reopening large histories. Only public reasoning summaries supplied by the engine can be shown.

The file browser and terminal use the server's OS privileges. Review currently applies Undo/Reapply to the aggregated diff, not individual hunks. Treat the workspace as shared with every admitted user.

## Find a conversation

Expand **Unassigned sessions** in the sidebar. **Recent sessions** shows at most the latest ten. Switch to **By directory** to browse working folders and load older conversations within a folder. The folder name is followed by its path; hover to see the complete path when it is shortened. The directory entry stays available even when all recently loaded conversations have already been assigned to projects.

A project's conversation list supports text search combined with a working-directory filter. **Link existing sessions** provides the same combination across native history, with pagination. Selected conversations remain selected when you change the search or directory, until you submit or close the dialog. Associating a conversation updates the unassigned directory count and does not move its working files.
