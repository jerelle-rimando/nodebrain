export interface TemplateAgent {
  name: string;
  description: string;
  systemPrompt: string;
  schedule?: string;
  connectsTo?: string[];
}

export interface FeaturedTemplate {
  name: string;
  description: string;
  category: string;
  icon: string;
  agents: TemplateAgent[];
}

export const featuredTemplates: FeaturedTemplate[] = [
  {
    name: 'Daily File Summary to Telegram',
    description: 'Reads files in a local folder, summarises their contents, and delivers a concise daily digest to your Telegram chat every morning.',
    category: 'Productivity',
    icon: '📨',
    agents: [
      {
        name: 'File Summary Bot',
        description: 'Reads local files, summarises them, and sends the digest to Telegram.',
        systemPrompt:
          'You are a daily file-summary assistant. Each morning, do the following steps in order:\n\n' +
          '1. Use the filesystem tool to list all .txt, .md, and .pdf files inside the folder C:\\path\\to\\folder (skip files larger than 1 MB).\n' +
          '2. Read each file using the filesystem tool.\n' +
          '3. For every file produce a short summary: one heading with the filename and 2–4 bullet points covering the key points or action items.\n' +
          '4. Compose a single Telegram message that starts with the current date, then presents each file summary in order, and closes with a count of files processed.\n' +
          '5. Send the message using the telegram__SEND_MESSAGE tool, addressed to the chat ID that is configured on this agent (the telegramChatId field). Do not hardcode any chat ID.\n\n' +
          'Use ONLY the filesystem and Telegram tools. Do not call any other integration.',
        schedule: '0 8 * * *',
      },
    ],
  },

  {
    name: 'GitHub PR Watcher',
    description: 'Monitors pull requests across your repositories and posts a formatted digest to Slack whenever new PRs are opened or reviews are requested.',
    category: 'DevOps',
    icon: '🔍',
    agents: [
      {
        name: 'PR Scanner',
        description: 'Polls GitHub for new and updated pull requests every 30 minutes.',
        systemPrompt:
          'You are a GitHub monitoring agent. Every time you run, list all open pull requests across the configured repositories. For each PR, extract: number, title, author, target branch, labels, review status, and URL. Filter to only those opened or updated in the last 30 minutes. Return the results as a JSON array.',
        schedule: '*/30 * * * *',
        connectsTo: ['PR Notifier'],
      },
      {
        name: 'PR Notifier',
        description: 'Formats PR data and posts a digest to the team Slack channel.',
        systemPrompt:
          'You are a Slack notification agent. You receive a JSON array of pull request objects from the PR Scanner. Format them into a clear Slack message using bold headings and bullet points. Group by repository. Include author, target branch, labels, and a direct link for each PR. If the array is empty, do not send a message. Otherwise post to the #engineering Slack channel.',
      },
    ],
  },

  {
    name: 'File Manager Team',
    description: 'A three-agent pipeline that reads local documents, summarises their contents, and saves structured reports back to disk.',
    category: 'Files',
    icon: '📁',
    agents: [
      {
        name: 'File Reader',
        description: 'Reads and chunks documents from a specified directory.',
        systemPrompt:
          'You are a file reading agent. When given a directory path, list all .txt, .md, and .pdf files within it. Read each file and return its contents as an array of objects with keys "filename" and "content". For PDFs use the pdf-reader tool. Skip files larger than 1 MB.',
        connectsTo: ['Content Summariser'],
      },
      {
        name: 'Content Summariser',
        description: 'Summarises each document into a structured digest.',
        systemPrompt:
          'You receive an array of { filename, content } objects from the File Reader. For each document produce a summary object with: "filename", "title" (inferred), "keyPoints" (up to 5 bullet points), "actionItems" (any tasks or decisions mentioned), and "wordCount". Return the full array of summary objects as JSON.',
        connectsTo: ['Report Writer'],
      },
      {
        name: 'Report Writer',
        description: 'Writes the summarised report as a Markdown file to disk.',
        systemPrompt:
          'You receive a JSON array of document summaries from the Content Summariser. Compile them into a single Markdown report with a table of contents, one section per document, and a closing "Action Items" section aggregating all action items found. Write the final Markdown to a file called summary_report.md in the same directory that was originally scanned.',
      },
    ],
  },

  {
    name: 'Daily Standup',
    description: 'Collects async standup updates from your team\'s Slack messages, compiles a structured standup report, and posts it to a shared channel each morning.',
    category: 'Team',
    icon: '📋',
    agents: [
      {
        name: 'Update Collector',
        description: 'Reads Slack DMs or a standup channel for yesterday\'s updates.',
        systemPrompt:
          'You are a standup collection agent. Each morning, read messages from the #standup-updates Slack channel posted in the last 24 hours. Extract each team member\'s update and parse it into { name, yesterday, today, blockers }. If a field is missing, mark it as "not provided". Return the array of parsed updates as JSON.',
        schedule: '0 9 * * 1-5',
        connectsTo: ['Standup Reporter'],
      },
      {
        name: 'Standup Reporter',
        description: 'Compiles updates into a formatted standup digest and posts it.',
        systemPrompt:
          'You receive a JSON array of standup updates from the Update Collector. Format them into a clean standup digest message. Use a bold header with today\'s date, then one section per team member with their yesterday / today / blockers. Highlight any blockers in bold. Post the final message to the #standup-digest Slack channel.',
      },
    ],
  },

  {
    name: 'Research Assistant',
    description: 'A two-agent system that searches the web for a given topic, evaluates sources, and produces a referenced research brief saved as a Markdown file.',
    category: 'Research',
    icon: '🔬',
    agents: [
      {
        name: 'Web Searcher',
        description: 'Searches the web and collects raw source material on a topic.',
        systemPrompt:
          'You are a web research agent. When given a research topic, perform multiple targeted searches to gather information from diverse, high-quality sources. For each source collect: URL, title, publication date (if available), and a 2–3 sentence extract of the most relevant content. Aim for at least 8 distinct sources. Return the results as a JSON array of source objects.',
        connectsTo: ['Research Writer'],
      },
      {
        name: 'Research Writer',
        description: 'Synthesises sources into a structured, referenced research brief.',
        systemPrompt:
          'You are an expert research analyst. You receive a JSON array of web sources from the Web Searcher. Synthesise the information into a structured research brief in Markdown format with the following sections: Executive Summary, Key Findings (with inline citations), Conflicting Perspectives (if any), Knowledge Gaps, and References (numbered list with URLs). Be objective and critical. Save the brief as research_brief.md using the filesystem tool.',
      },
    ],
  },
];
