/**
 * クライアント管理画面用の小さな UI 部品（T-01b-2）
 * 既存画面には共通部品が無いため、ここに閉じて置く。Tailwind のみ。
 */

import React, { useEffect, useState } from "react";

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-700 shadow-sm",
  secondary: "bg-gray-100 text-gray-800 hover:bg-gray-200 border border-gray-300",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm",
  ghost: "bg-transparent text-gray-600 hover:bg-gray-100",
};

export const Button: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }
> = ({ variant = "primary", busy = false, className = "", children, disabled, ...rest }) => (
  <button
    type="button"
    disabled={disabled || busy}
    className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_CLASS[variant]} ${className}`}
    {...rest}
  >
    {busy ? "処理中..." : children}
  </button>
);

export const FieldError: React.FC<{ message?: string | null }> = ({ message }) =>
  message ? (
    <p className="mt-1 text-sm text-red-600" role="alert">
      {message}
    </p>
  ) : null;

export const Field: React.FC<{
  label: string;
  htmlFor?: string;
  required?: boolean;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}> = ({ label, htmlFor, required, hint, error, children }) => (
  <div className="mb-4">
    <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700 mb-1">
      {label}
      {required && <span className="ml-1 text-red-500">*</span>}
    </label>
    {children}
    {hint && !error && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    <FieldError message={error} />
  </div>
);

const INPUT_CLASS =
  "w-full rounded-lg border px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-100";

export const TextInput: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
> = ({ invalid, className = "", ...rest }) => (
  <input
    className={`${INPUT_CLASS} ${invalid ? "border-red-400" : "border-gray-300"} ${className}`}
    {...rest}
  />
);

export const TextArea: React.FC<
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
> = ({ invalid, className = "", ...rest }) => (
  <textarea
    className={`${INPUT_CLASS} ${invalid ? "border-red-400" : "border-gray-300"} ${className}`}
    {...rest}
  />
);

export const Select: React.FC<
  React.SelectHTMLAttributes<HTMLSelectElement> & {
    invalid?: boolean;
    options: { value: string; label: string }[];
  }
> = ({ invalid, options, className = "", ...rest }) => (
  <select
    className={`${INPUT_CLASS} ${invalid ? "border-red-400" : "border-gray-300"} ${className}`}
    {...rest}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

export const Toggle: React.FC<{
  id?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}> = ({ id, checked, onChange, label, description, disabled }) => (
  <label htmlFor={id} className="flex items-start gap-3 mb-4 cursor-pointer">
    <input
      id={id}
      type="checkbox"
      className="mt-1 h-4 w-4"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
    <span>
      <span className="block text-sm font-medium text-gray-700">{label}</span>
      {description && <span className="block text-xs text-gray-500">{description}</span>}
    </span>
  </label>
);

/**
 * カンマ区切りで配列を入力する。表示は文字列のまま保持し、
 * 確定（blur）時に trim・空要素除去して配列へ変換する。
 */
export const TagsInput: React.FC<{
  id?: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  invalid?: boolean;
}> = ({ id, value, onChange, placeholder, invalid }) => {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    setText(value.join(", "));
  }, [value]);
  return (
    <TextInput
      id={id}
      value={text}
      placeholder={placeholder}
      invalid={invalid}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(parseTags(text))}
    />
  );
};

export function parseTags(text: string): string[] {
  return String(text || "")
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export const Section: React.FC<{
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, actions, children }) => (
  <section className="bg-white rounded-2xl shadow-sm border border-gray-200 p-6 mb-6">
    <div className="flex items-start justify-between gap-4 mb-4">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">{title}</h2>
        {description && <p className="text-sm text-gray-500">{description}</p>}
      </div>
      {actions && <div className="flex gap-2 shrink-0">{actions}</div>}
    </div>
    {children}
  </section>
);

export const Notice: React.FC<{
  tone: "error" | "warning" | "success" | "info";
  children: React.ReactNode;
  onClose?: () => void;
}> = ({ tone, children, onClose }) => {
  const cls = {
    error: "bg-red-50 border-red-200 text-red-700",
    warning: "bg-amber-50 border-amber-200 text-amber-800",
    success: "bg-green-50 border-green-200 text-green-800",
    info: "bg-blue-50 border-blue-200 text-blue-800",
  }[tone];
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm mb-4 ${cls}`} role="status">
      <div>{children}</div>
      {onClose && (
        <button type="button" className="text-xs underline" onClick={onClose}>
          閉じる
        </button>
      )}
    </div>
  );
};

export const Table: React.FC<{ headers: string[]; children: React.ReactNode }> = ({ headers, children }) => (
  <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
    <table className="min-w-full text-sm">
      <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
        <tr>
          {headers.map((h) => (
            <th key={h} className="px-4 py-3 font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">{children}</tbody>
    </table>
  </div>
);

export const ConfirmDialog: React.FC<{
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ open, title, children, confirmLabel, busy, onConfirm, onCancel }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-gray-800 mb-3">{title}</h3>
        <div className="text-sm text-gray-700 mb-6">{children}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="danger" onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};

export const Spinner: React.FC<{ label?: string }> = ({ label = "読み込み中..." }) => (
  <div className="flex items-center gap-3 p-6 text-sm text-gray-600">
    <div className="h-5 w-5 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
    {label}
  </div>
);
