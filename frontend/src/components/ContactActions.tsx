import { useEffect, useState } from "react";
import { Phone, MessageCircle } from "lucide-react";
import { phoneLink } from "../shared/contact";

export default function ContactActions({
  phone,
  wechatId,
}: {
  phone?: string;
  wechatId?: string;
}) {
  const [message, setMessage] = useState("");
  const [manual, setManual] = useState<{ label: string; value: string }>();
  const [copying, setCopying] = useState("");
  const number = phoneLink(phone)?.slice(4);
  useEffect(() => {
    setMessage("");
    setManual(undefined);
  }, [phone, wechatId]);
  const copy = async (label: string, value: string) => {
    setCopying(label);
    setMessage("");
    try {
      await navigator.clipboard.writeText(value);
      setManual(undefined);
      setMessage(
        label === "手机号"
          ? "手机号已复制，可以到拨号界面粘贴。"
          : "微信号已复制，可以到微信粘贴。",
      );
    } catch {
      setManual({ label, value });
      setMessage(`请长按下面的${label}，选择复制。`);
    } finally {
      setCopying("");
    }
  };
  if (!number && !wechatId) return null;
  return (
    <div className="contact-actions">
      <div className="contact-buttons">
        {number && (
          <button
            type="button"
            className="button primary"
            disabled={!!copying}
            onClick={() => void copy("手机号", number)}
          >
            <Phone size={23} />
            {copying === "手机号" ? "复制中…" : "复制号码"}
          </button>
        )}
        {wechatId && (
          <button
            type="button"
            className="button secondary"
            disabled={!!copying}
            onClick={() => void copy("微信号", wechatId)}
          >
            <MessageCircle size={23} />
            {copying === "微信号" ? "复制中…" : "复制微信"}
          </button>
        )}
      </div>
      {message && (
        <p role="status" className="contact-feedback">
          {message}
        </p>
      )}
      {manual && (
        <input
          aria-label={`长按复制${manual.label}`}
          readOnly
          value={manual.value}
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
    </div>
  );
}
