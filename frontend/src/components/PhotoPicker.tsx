import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Alert } from "./UI";
import { errorText, preparePhoto } from "../api";

export default function PhotoPicker({
  name,
  disabled = false,
  onPhoto,
  photoUrl,
  photoBase64,
  onPhotoPreparing,
}: {
  name?: string;
  disabled?: boolean;
  onPhoto?: (base64: string) => void;
  photoUrl?: string;
  photoBase64?: string;
  onPhotoPreparing?: (preparing: boolean) => void;
}) {
  const [photoError, setPhotoError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
      onPhotoPreparing?.(false);
    },
    [onPhotoPreparing],
  );
  return (
    <>
      <div className="photo-field">
        <div className="avatar large">
          {photoBase64 || photoUrl ? (
            <img
              alt="个人照片"
              src={
                photoBase64 ? `data:image/jpeg;base64,${photoBase64}` : photoUrl
              }
            />
          ) : (
            name?.slice(-2) || <Camera size={26} />
          )}
        </div>
        {onPhoto && (
          <label className="button secondary upload-button">
            {preparing ? "正在处理…" : "选择照片"}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={disabled || preparing}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const version = ++generation.current;
                setPhotoError("");
                setPreparing(true);
                onPhotoPreparing?.(true);
                try {
                  const photo = await preparePhoto(file);
                  if (version === generation.current) onPhoto(photo);
                } catch (err) {
                  if (version === generation.current)
                    setPhotoError(errorText(err));
                } finally {
                  if (version === generation.current) {
                    setPreparing(false);
                    onPhotoPreparing?.(false);
                  }
                  e.target.value = "";
                }
              }}
            />
          </label>
        )}
        <span className="hint">留下熟悉的面孔</span>
      </div>
      <Alert message={photoError} />
    </>
  );
}
