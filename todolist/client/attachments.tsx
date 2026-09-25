import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { writeFile } from "../shared/contracts";
import { createId } from "../shared/ids";
import { FILE_MAX_COUNT, IMAGE_MAX_COUNT, validateWorkItemFiles, validateWorkItemImages, type FieldError } from "../shared/limits";
import { describeFileError, fileKind, formatBytes, pickFiles as pickPlatformFiles, uploadFile, type DraftFile, type PickedFile } from "./files";
import { HOST_IMAGE_PREVIEW, ImagePreview, openHostImagePreview } from "./image-preview";
import { describeImageError, imageDataUri, pickImageDrafts, type DraftImage } from "./images";
import type { TodoStyles } from "./styles";
import { subscribeDroppedFilesWeb } from "./web";

type ImageRefusal = Extract<FieldError, { field: "images" }>["reason"];
type FileRefusal = Extract<FieldError, { field: "files" }>["reason"];

let nextTargetId = 0;

/** What a Todo text box has attached before it is submitted: images, and files of any kind. */
export interface DraftAttachments {
  images: DraftImage[];
  files: DraftFile[];
  /** Put this on the box as `nativeID`: images and files pasted or dropped inside it land here. */
  targetId: string;
  picking: boolean;
  /** Files are being dragged over the box, so it can say they will attach. */
  dragging: boolean;
  /** Some file is still on its way to the host; the box waits for it before saving. */
  uploading: boolean;
  full: boolean;
  pickImages: () => Promise<void>;
  pickFiles: () => Promise<void>;
  removeImage: (id: string) => void;
  removeFile: (id: string) => void;
  /** Replaces what is given and keeps the rest. */
  reset: (next: { images?: DraftImage[]; files?: DraftFile[] }) => void;
}

/**
 * Attachments for one text box, starting from `initial`: the "+" choosers, paste and drop while
 * `active`, the caps, and a toast for anything refused. Oversized images arrive already scaled
 * down by `client/web.ts`. Files upload to the daemon host as soon as they are added, so the card
 * only has to carry their references; an upload stops when its file is removed or the box closes.
 */
export function useDraftAttachments(active: boolean, initial: { images?: DraftImage[]; files?: DraftFile[] } = {}): DraftAttachments {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const write = useRpc(writeFile);
  const [images, setImages] = useState<DraftImage[]>(initial.images ?? []);
  const [files, setFiles] = useState<DraftFile[]>(initial.files ?? []);
  // Choosers, pastes and uploads resolve asynchronously; they change what is there then.
  const imagesRef = useRef<DraftImage[]>(images);
  const filesRef = useRef<DraftFile[]>(files);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const pickingRef = useRef(false);
  const mounted = useRef(true);
  const [targetId] = useState(() => `todo-attach-drop-${++nextTargetId}`);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const updateImages = useCallback((next: DraftImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);
  const updateFiles = useCallback((change: (current: DraftFile[]) => DraftFile[]) => {
    filesRef.current = change(filesRef.current);
    setFiles(filesRef.current);
  }, []);
  const reset = useCallback(
    (next: { images?: DraftImage[]; files?: DraftFile[] }) => {
      if (next.images) updateImages(next.images);
      if (next.files) updateFiles(() => next.files ?? []);
    },
    [updateFiles, updateImages],
  );

  const addImages = useCallback(
    (picked: DraftImage[]) => {
      if (picked.length === 0) return;
      const next = [...imagesRef.current];
      let refused: ImageRefusal | null = null;
      for (const draft of picked) {
        if (next.length >= IMAGE_MAX_COUNT) {
          refused ??= "too_many";
          break;
        }
        const invalid = validateWorkItemImages([draft]);
        if (invalid?.field === "images") {
          refused ??= invalid.reason;
          continue;
        }
        next.push(draft);
      }
      if (refused) toastRef.current.error(describeImageError(refused));
      if (next.length !== imagesRef.current.length) updateImages(next);
    },
    [updateImages],
  );

  const addFiles = useCallback(
    (picked: PickedFile[]) => {
      const added: { draft: DraftFile; file: PickedFile }[] = [];
      let refused: FileRefusal | null = null;
      for (const file of picked) {
        if (filesRef.current.length + added.length >= FILE_MAX_COUNT) {
          refused ??= "too_many";
          break;
        }
        const invalid = validateWorkItemFiles([{ name: file.name, byteLength: file.size }]);
        if (invalid?.field === "files") {
          refused ??= invalid.reason;
          continue;
        }
        added.push({ draft: { id: createId("file"), name: file.name, mimeType: file.mimeType, byteLength: file.size, uploaded: 0, ready: false }, file });
      }
      if (refused) toastRef.current.error(describeFileError(refused));
      if (added.length === 0) return;
      updateFiles((current) => [...current, ...added.map((entry) => entry.draft)]);
      const patch = (id: string, change: Partial<DraftFile>) => updateFiles((current) => current.map((entry) => (entry.id === id ? { ...entry, ...change } : entry)));
      void (async () => {
        for (const { draft, file } of added) {
          const gone = () => !mounted.current || !filesRef.current.some((entry) => entry.id === draft.id);
          try {
            await uploadFile(file, draft.id, write, (uploaded) => patch(draft.id, { uploaded }), gone);
            patch(draft.id, { uploaded: draft.byteLength, ready: true });
          } catch (error) {
            if (gone()) continue;
            updateFiles((current) => current.filter((entry) => entry.id !== draft.id));
            toastRef.current.error(error instanceof Error ? error.message : `Could not upload ${file.name}.`);
          }
        }
      })();
    },
    [updateFiles, write],
  );

  useEffect(() => {
    if (!active) return undefined;
    const unsubscribe = subscribeDroppedFilesWeb(targetId, { onImages: addImages, onFiles: addFiles, onDragging: setDragging });
    return () => {
      unsubscribe?.();
      setDragging(false);
    };
  }, [active, addFiles, addImages, targetId]);

  /** One chooser at a time; `choose` returns false where the platform has none. */
  const withChooser = useCallback(async (choose: () => Promise<boolean>, failure: string) => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    setPicking(true);
    try {
      if (!(await choose())) toastRef.current.error("Adding attachments needs the desktop or web app.");
    } catch {
      toastRef.current.error(failure);
    } finally {
      pickingRef.current = false;
      setPicking(false);
    }
  }, []);

  const pickImages = useCallback(
    () =>
      withChooser(async () => {
        const picked = await pickImageDrafts(Math.max(1, IMAGE_MAX_COUNT - imagesRef.current.length));
        if (picked === null) return false;
        addImages(picked);
        return true;
      }, "Could not open your photos. Allow Paseo to access them, then try again."),
    [addImages, withChooser],
  );

  const pickFiles = useCallback(
    () =>
      withChooser(async () => {
        const picked = await pickPlatformFiles();
        if (picked === null) return false;
        addFiles(picked);
        return true;
      }, "Could not open the file chooser."),
    [addFiles, withChooser],
  );

  const removeImage = useCallback((id: string) => updateImages(imagesRef.current.filter((image) => image.id !== id)), [updateImages]);
  const removeFile = useCallback((id: string) => updateFiles((current) => current.filter((file) => file.id !== id)), [updateFiles]);

  return {
    images,
    files,
    targetId,
    picking,
    dragging,
    uploading: files.some((file) => !file.ready),
    full: images.length >= IMAGE_MAX_COUNT && files.length >= FILE_MAX_COUNT,
    pickImages,
    pickFiles,
    removeImage,
    removeFile,
    reset,
  };
}

/**
 * Attached images as thumbnails that open a full-window preview (the host's zoomable viewer where
 * there is one), then attached files by name and size. Each carries a remove button when its
 * `onRemove` is given.
 */
export function AttachmentStrip(props: {
  styles: TodoStyles;
  theme: PluginTheme;
  images: readonly DraftImage[];
  files?: readonly DraftFile[];
  onRemoveImage?: (id: string) => void;
  onRemoveFile?: (id: string) => void;
  size?: number;
}) {
  const { theme } = props;
  const size = props.size ?? 56;
  const files = props.files ?? [];
  const [preview, setPreview] = useState<number | null>(null);
  if (props.images.length === 0 && files.length === 0) return null;
  const removable = Boolean(props.onRemoveImage || props.onRemoveFile);
  return (
    <>
      <View style={[props.styles.rowWrap, { gap: 8, paddingTop: removable ? 6 : 0 }]}>
        {props.images.map((image, index) => (
          <View key={image.id} style={{ width: size, height: size }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${image.name ?? "image"}`}
              onPress={() => {
                if (!openHostImagePreview(props.images, index)) setPreview(index);
              }}
              style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({ opacity: pressed ? 0.75 : hovered ? 0.88 : 1 })}
            >
              <Image
                source={{ uri: imageDataUri(image) }}
                style={{ width: size, height: size, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border }}
                accessibilityLabel={image.name ?? "Attached image"}
                resizeMode="cover"
              />
            </Pressable>
            {props.onRemoveImage ? <RemoveButton theme={theme} label={`Remove ${image.name ?? "image"}`} onPress={() => props.onRemoveImage?.(image.id)} /> : null}
          </View>
        ))}
        {files.map((file) => (
          <FileChip key={file.id} theme={theme} file={file} height={size} {...(props.onRemoveFile ? { onRemove: () => props.onRemoveFile?.(file.id) } : {})} />
        ))}
      </View>
      {HOST_IMAGE_PREVIEW ? null : <ImagePreview theme={theme} images={props.images} index={preview} onIndex={setPreview} />}
    </>
  );
}

function FileChip(props: { theme: PluginTheme; file: DraftFile; height: number; onRemove?: () => void }) {
  const { theme, file } = props;
  const detail = file.ready ? `${fileKind(file)} · ${formatBytes(file.byteLength)}` : `Uploading ${file.byteLength > 0 ? Math.floor((file.uploaded / file.byteLength) * 100) : 0}%`;
  return (
    <View>
      <View
        accessibilityLabel={`${file.name}, ${detail}`}
        style={{
          height: props.height,
          maxWidth: 240,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 10,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
        }}
      >
        <Icon name={file.ready ? "FileText" : "LoaderCircle"} size={16} color={theme.colors.foregroundMuted} />
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
            {file.name}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5, marginTop: 1 }} numberOfLines={1}>
            {detail}
          </Text>
        </View>
      </View>
      {props.onRemove ? <RemoveButton theme={theme} label={`Remove ${file.name}`} onPress={props.onRemove} /> : null}
    </View>
  );
}

function RemoveButton(props: { theme: PluginTheme; label: string; onPress: () => void }) {
  const { theme } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      hitSlop={6}
      onPress={props.onPress}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => ({
        position: "absolute",
        top: -6,
        right: -6,
        width: 18,
        height: 18,
        borderRadius: 9,
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: hovered || pressed ? theme.colors.surface2 : theme.colors.surface1,
      })}
    >
      <Icon name="X" size={11} color={theme.colors.foreground} />
    </Pressable>
  );
}
