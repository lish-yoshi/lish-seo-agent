import React from "react";
import type { AdminClient } from "./api";
import { Table } from "./ui";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const ClientList: React.FC<{ clients: AdminClient[]; onSelect: (id: string) => void }> = ({ clients, onSelect }) => {
  if (clients.length === 0) {
    return <p className="p-6 text-sm text-gray-500">クライアントはまだ登録されていません。</p>;
  }
  return (
    <Table headers={["ID", "表示名", "状態", "テスト", "サイト", "CMS", "スプシ", "更新日時"]}>
      {clients.map((c) => (
        <tr
          key={c.id}
          onClick={() => onSelect(c.id)}
          className={`cursor-pointer hover:bg-blue-50 ${c.enabled ? "" : "opacity-50"}`}
          data-client-id={c.id}
        >
          <td className="px-4 py-3 font-mono text-xs">{c.id}</td>
          <td className="px-4 py-3">{c.label}</td>
          <td className="px-4 py-3">
            {c.enabled ? (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-800">有効</span>
            ) : (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">無効</span>
            )}
          </td>
          <td className="px-4 py-3">{c.isTest ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">テスト</span> : ""}</td>
          <td className="px-4 py-3 font-mono text-xs">{c.siteUrl ?? "—"}</td>
          <td className="px-4 py-3 text-xs">{c.cms.type}</td>
          <td className="px-4 py-3 text-xs">{c.spreadsheetId && c.spreadsheetId.trim() !== "" ? "あり" : <span className="text-amber-700">なし</span>}</td>
          <td className="px-4 py-3 text-xs text-gray-500">{formatDate(c.updatedAt)}</td>
        </tr>
      ))}
    </Table>
  );
};

export default ClientList;
