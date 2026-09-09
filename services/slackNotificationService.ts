// Slack通知サービス
interface SlackMessage {
  text: string;
  attachments?: Array<{
    color: "good" | "warning" | "danger" | string;
    title?: string;
    text?: string;
    fields?: Array<{
      title: string;
      value: string;
      short?: boolean;
    }>;
    footer?: string;
    ts?: number;
  }>;
}

interface NotificationData {
  keyword?: string;
  step?: string;
  status?: "start" | "progress" | "complete" | "error";
  h2Count?: number;
  h3Count?: number;
  charCount?: number;
  score?: number;
  timeElapsed?: number;
  totalTime?: number;
  error?: string;
  url?: string;
  cautionNotes?: Array<{
    location: string;
    claim: string;
  }>; // 要確認箇所のリスト
}

class SlackNotificationService {
  private enabled: boolean;
  private startTime: number = 0;
  private stepTimes: Map<string, number> = new Map();
  private mentionUserId: string = ""; // SlackユーザーID（例: U1234567890）
  private useMention: boolean = true; // メンション使用フラグ

  constructor() {
    this.enabled = import.meta.env.VITE_ENABLE_SLACK_NOTIFICATIONS === "true";
    this.mentionUserId = import.meta.env.VITE_SLACK_MENTION_USER_ID || ""; // 環境変数から取得
    this.useMention = import.meta.env.VITE_SLACK_USE_MENTION !== "false"; // デフォルトtrue
  }

  // メンション文字列を取得
  private getMention(): string {
    if (!this.useMention) return "";

    // ユーザーIDが設定されている場合は特定ユーザーにメンション
    if (this.mentionUserId) {
      return `<@${this.mentionUserId}>`;
    }

    // 設定されていない場合は@hereを使用
    return "<!here>";
  }

  private async send(message: SlackMessage): Promise<void> {
    if (!this.enabled) return;

    try {
      // サーバー経由でSlack通知を送信（CORS回避）
      const apiKey = import.meta.env.VITE_INTERNAL_API_KEY;
      if (!apiKey) {
        console.warn(
          "⚠️ Slack通知: VITE_INTERNAL_API_KEY が未設定のため送信できません"
        );
        return;
      }
      const backendUrl =
        import.meta.env.VITE_BACKEND_URL || "";
      const response = await fetch(`${backendUrl}/api/slack-notify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey, // 認証ヘッダーを追加
        },
        body: JSON.stringify({ message }),
      });

      if (!response.ok) {
        const error = await response.json();
        console.error("❌ Slack通知の送信に失敗しました:", error);
      } else {
        console.log("✅ Slack通知を送信しました");
      }
    } catch (error) {
      console.error("❌ Slack通知エラー:", error);
    }
  }

  // 記事生成開始通知
  async notifyStart(data: NotificationData): Promise<void> {
    this.startTime = Date.now();
    this.stepTimes.clear();

    const message: SlackMessage = {
      text: `🚀 *テキスト生成を開始しました*`,
      attachments: [
        {
          color: "#3b82f6",
          fields: [
            {
              title: "キーワード",
              value: data.keyword || "未設定",
              short: true,
            },
            {
              title: "開始時刻",
              value: new Date().toLocaleTimeString("ja-JP"),
              short: true,
            },
          ],
          footer: "SEO Content Generator",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    await this.send(message);
  }

  // ステップ開始通知（内部用）
  async notifyStepStart(stepName: string): Promise<void> {
    // ステップの開始時間を記録
    this.stepTimes.set(stepName, Date.now());
  }

  // 最終校閲完了通知（要確認箇所を含む）
  async notifyProofreadingComplete(
    data: NotificationData & {
      proofreadingScore?: number;
      cautionNotes?: Array<{ location: string; claim: string }>;
    }
  ): Promise<void> {
    const emoji = "🔍";
    const color =
      data.proofreadingScore && data.proofreadingScore >= 75
        ? "good"
        : "warning";

    const attachments: any[] = [
      {
        color,
        title: "最終校閲結果",
        fields: [
          {
            title: "レギュレーションスコア",
            value: `${data.proofreadingScore || 0}/100`,
            short: true,
          },
          {
            title: "判定",
            value:
              data.proofreadingScore && data.proofreadingScore >= 75
                ? "✅ 合格"
                : "⚠️ 要修正",
            short: true,
          },
        ],
        footer: "Final Proofreading",
        ts: Math.floor(Date.now() / 1000),
      },
    ];

    // 要確認箇所がある場合
    if (data.cautionNotes && data.cautionNotes.length > 0) {
      attachments.push({
        color: "warning",
        title: `⚠️ 出典が見つからなかった箇所（${data.cautionNotes.length}件）`,
        text: data.cautionNotes
          .map(
            (note, index) =>
              `${index + 1}. *${note.location}*\n   「${note.claim}」`
          )
          .join("\n\n"),
        footer: "これらの箇所は修正または削除を検討してください",
        ts: Math.floor(Date.now() / 1000),
      });
    }

    const message: SlackMessage = {
      text: `${emoji} *最終校閲が完了しました*`,
      attachments,
    };

    await this.send(message);
  }

  // ステップ完了通知
  async notifyStepComplete(data: NotificationData): Promise<void> {
    // ステップの開始時間を取得（記録されていない場合は全体の開始時間を使用）
    const stepStartTime = this.stepTimes.get(data.step || "") || this.startTime;
    const elapsed = Math.round((Date.now() - stepStartTime) / 1000);

    let emoji = "✅";
    let color = "good";
    let details = "";

    switch (data.step) {
      case "competitor-research":
        emoji = "🔍";
        details = `分析サイト数: ${data.h2Count || 0}件`;
        break;
      case "outline":
        emoji = "📋";
        details = `H2: ${data.h2Count}個, H3: ${data.h3Count}個`;
        break;
      case "writing":
        emoji = "✍️";
        details = `文字数: ${data.charCount?.toLocaleString()}文字`;
        break;
      case "check":
        emoji = "📊";
        details = `スコア: ${data.score}/100`;
        break;
      case "revision":
        emoji = "🔧";
        details = "修正完了";
        break;
      case "final":
        emoji = "🎯";
        details = `最終スコア: ${data.score}/100`;
        break;
    }

    const message: SlackMessage = {
      text: `${emoji} *${data.step}* 完了 (${elapsed}秒)`,
      attachments: details
        ? [
            {
              color: color,
              text: details,
              footer: `経過時間: ${Math.round(
                (Date.now() - this.startTime) / 1000
              )}秒`,
              ts: Math.floor(Date.now() / 1000),
            },
          ]
        : undefined,
    };

    await this.send(message);
  }

  // 記事生成完了通知
  async notifyComplete(data: NotificationData): Promise<void> {
    const totalTime = Math.round((Date.now() - this.startTime) / 1000);
    const minutes = Math.floor(totalTime / 60);
    const seconds = totalTime % 60;
    const timeStr = minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;

    // メンションを削除（メンションなしで通知）
    // const mention = this.getMention();
    // const mentionText = mention ? `${mention} ` : '';

    const attachments: any[] = [
      {
        color: "good",
        title: "生成結果",
        fields: [
          {
            title: "キーワード",
            value: data.keyword || "未設定",
            short: true,
          },
          {
            title: "文字数",
            value: `${data.charCount?.toLocaleString()}文字`,
            short: true,
          },
          
          {
            title: "所要時間",
            value: timeStr,
            short: true,
          },
        ],
        footer: "SEO Content Generator",
        ts: Math.floor(Date.now() / 1000),
      },
    ];

    // 要確認箇所がある場合は追加
    if (data.cautionNotes && data.cautionNotes.length > 0) {
      attachments.push({
        color: "warning",
        title: `⚠️ 要確認箇所（${data.cautionNotes.length}件）`,
        text: data.cautionNotes
          .map(
            (note, index) =>
              `${index + 1}. *${note.location}*\n   ${note.claim}`
          )
          .join("\n\n"),
        footer:
          "出典が見つからなかった箇所です。手動で確認・修正してください。",
        ts: Math.floor(Date.now() / 1000),
      });
    }

    const message: SlackMessage = {
      text: `🎉 *テキスト生成が完了しました！*`,
      attachments,
    };

    await this.send(message);
  }

  // エラー通知
  async notifyError(data: NotificationData): Promise<void> {
    // メンションを追加（エラー時は必ずメンション）
    const mention = this.getMention();
    const mentionText = mention ? `${mention} ` : "";

    const message: SlackMessage = {
      text: `${mentionText}❌ *エラーが発生しました*`,
      attachments: [
        {
          color: "danger",
          fields: [
            {
              title: "ステップ",
              value: data.step || "不明",
              short: true,
            },
            {
              title: "キーワード",
              value: data.keyword || "未設定",
              short: true,
            },
            {
              title: "エラー内容",
              value: data.error || "不明なエラー",
              short: false,
            },
          ],
          footer: "SEO Content Generator",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    await this.send(message);
  }

  // 修正エラー通知（原文が残っている場合）
  async notifyRevisionError(data: {
    keyword: string;
    location: string;
    originalText: string;
    problemDescription: string;
    suggestedText: string;
    revisedContent: string;
  }): Promise<void> {
    // メンションを追加（修正エラー時は必ずメンション）
    const mention = this.getMention();
    const mentionText = mention ? `${mention} ` : "";

    // 修正後のコンテンツから該当箇所の前後を抽出（最大200文字）
    const contextLength = 100;
    const originalPosition = data.revisedContent.indexOf(data.originalText);
    let contextText = "";
    if (originalPosition >= 0) {
      const start = Math.max(0, originalPosition - contextLength);
      const end = Math.min(
        data.revisedContent.length,
        originalPosition + data.originalText.length + contextLength
      );
      contextText = data.revisedContent.substring(start, end);
      if (start > 0) contextText = "..." + contextText;
      if (end < data.revisedContent.length) contextText = contextText + "...";
    } else {
      contextText = "（該当箇所が見つかりませんでした）";
    }

    const message: SlackMessage = {
      text: `${mentionText}⚠️ *修正後も原文が残っている可能性があります*`,
      attachments: [
        {
          color: "warning",
          title: "キーワード",
          text: data.keyword,
          footer: "Revision Service Alert",
          ts: Math.floor(Date.now() / 1000),
        },
        {
          color: "#4CAF50",
          title: "該当箇所",
          text: data.location,
          footer: "問題が検出された位置",
        },
        {
          color: "danger",
          title: "1. 問題の原文",
          text: `\`\`\`${data.originalText}\`\`\``,
          footer: "修正対象として指定された文章",
        },
        {
          color: "#FFA500",
          title: "2. 問題の理由",
          text: data.problemDescription,
          footer: "最終校閲エージェントからの指摘",
        },
        {
          color: "#3b82f6",
          title: "3. 推奨される修正文",
          text: `\`\`\`${data.suggestedText}\`\`\``,
          footer: "提案された修正内容",
        },
        {
          color: "#808080",
          title: "4. 実際の修正後の該当箇所",
          text: `\`\`\`${contextText}\`\`\``,
          footer:
            originalPosition >= 0
              ? `修正後のHTML内の位置: ${originalPosition}文字目`
              : "修正が適用されなかった可能性があります",
        },
      ],
    };

    await this.send(message);
  }

  // テスト通知
  async sendTestNotification(): Promise<void> {
    const message: SlackMessage = {
      text: "🔔 *Slack通知のテスト*",
      attachments: [
        {
          color: "#10b981",
          text: "Slack通知が正常に設定されました！",
          fields: [
            {
              title: "ステータス",
              value: "✅ 接続成功",
              short: true,
            },
            {
              title: "テスト時刻",
              value: new Date().toLocaleString("ja-JP"),
              short: true,
            },
          ],
          footer: "SEO Content Generator",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    await this.send(message);
    console.log("📤 テスト通知を送信しました");
  }

  // 画像生成開始通知
  async notifyImageGeneration(data: {
    keyword: string;
    score: number;
    title: string;
  }): Promise<void> {
    if (!this.enabled) return;

    const message: SlackMessage = {
      text: `🎨 *画像生成を開始しました*`,
      attachments: [
        {
          color: "good",
          fields: [
            {
              title: "キーワード",
              value: data.keyword,
              short: true,
            },
            {
              title: "記事タイトル",
              value: data.title,
              short: false,
            },
            {
              title: "最終スコア",
              value: `${data.score}点`,
              short: true,
            },
          ],
          footer: "Image Generation Agent",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    await this.send(message);
  }
}

// シングルトンインスタンスをエクスポート
export const slackNotifier = new SlackNotificationService();

// 型定義もエクスポート
export type { NotificationData };
