import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Code,
  Dialog,
  Field,
  HStack,
  Input,
  Portal,
  Stack,
} from "@chakra-ui/react";
import { api, SaveSettingsBody, Settings } from "./api";

interface Props {
  open: boolean;
  initial: Settings;
  firstRun: boolean;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}

export function SettingsModal({ open, initial, firstRun, onClose, onSaved }: Props) {
  const [linkTarget, setLinkTarget] = useState<string>(initial.repoLinkTarget ?? "");
  const [installCmd, setInstallCmd] = useState<string>(initial.dashboardInstallCmd ?? "");
  const [startCmd, setStartCmd] = useState<string>(initial.dashboardStartCmd ?? "");
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLinkTarget(initial.repoLinkTarget ?? "");
    setInstallCmd(initial.dashboardInstallCmd ?? "");
    setStartCmd(initial.dashboardStartCmd ?? "");
  }, [initial.repoLinkTarget, initial.dashboardInstallCmd, initial.dashboardStartCmd]);

  async function pick() {
    setPicking(true);
    setErr(null);
    try {
      const res = await api.pickFolder();
      if (res) setLinkTarget(res.path);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPicking(false);
    }
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const body: SaveSettingsBody = {};
      if (linkTarget) body.linkTarget = linkTarget;
      body.dashboardInstallCmd = installCmd.trim();
      body.dashboardStartCmd = startCmd.trim();
      const next = await api.saveSettings(body);
      onSaved(next);
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open && !firstRun) onClose();
      }}
      placement="center"
      size="lg"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Settings</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap={5}>
                <Field.Root required={firstRun}>
                  <Field.Label fontSize="xs" color="gray.400">
                    Repo folder {firstRun && <Field.RequiredIndicator />}
                  </Field.Label>
                  <HStack gap={2} w="100%">
                    <Input
                      readOnly
                      value={linkTarget}
                      placeholder="No folder selected"
                      onClick={pick}
                      cursor="pointer"
                      fontFamily="mono"
                      fontSize="sm"
                      _placeholder={{ color: "gray.500", fontFamily: "body" }}
                    />
                    <Button
                      variant="subtle"
                      onClick={pick}
                      loading={picking}
                      disabled={saving}
                      flexShrink={0}
                    >
                      {linkTarget ? "Change…" : "Choose…"}
                    </Button>
                    {linkTarget && (
                      <Button
                        variant="ghost"
                        onClick={() => setLinkTarget("")}
                        disabled={saving || picking}
                        flexShrink={0}
                        color="gray.400"
                      >
                        Clear
                      </Button>
                    )}
                  </HStack>
                  <Field.HelperText fontSize="xs" color="gray.500">
                    Pick your local <Code colorPalette="gray">{initial.repoUrl}</Code> checkout. The tool
                    symlinks it into the worktrees directory — nothing is cloned or copied.
                  </Field.HelperText>
                </Field.Root>
                <Field.Root>
                  <Field.Label fontSize="xs" color="gray.400">Dashboard install command</Field.Label>
                  <Input
                    placeholder="yarn install"
                    value={installCmd}
                    onChange={(e) => setInstallCmd(e.target.value)}
                    disabled={saving}
                  />
                  <Field.HelperText fontSize="xs" color="gray.500">
                    Runs in each worktree before the dev server. Leave blank for <Code>yarn install</Code>.
                  </Field.HelperText>
                </Field.Root>
                <Field.Root>
                  <Field.Label fontSize="xs" color="gray.400">Dashboard start command</Field.Label>
                  <Input
                    placeholder="yarn start-dashboard"
                    value={startCmd}
                    onChange={(e) => setStartCmd(e.target.value)}
                    disabled={saving}
                  />
                  <Field.HelperText fontSize="xs" color="gray.500">
                    Invoked as <Code>PORT=&lt;port&gt; &lt;cmd&gt;</Code>. Leave blank for <Code>yarn start-dashboard</Code>.
                  </Field.HelperText>
                </Field.Root>
                {err && (
                  <Alert.Root status="error">
                    <Alert.Indicator />
                    <Alert.Title>{err}</Alert.Title>
                  </Alert.Root>
                )}
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <HStack gap={2}>
                {!firstRun && (
                  <Button variant="outline" onClick={onClose} disabled={saving}>
                    Cancel
                  </Button>
                )}
                <Button colorPalette="blue" onClick={save} loading={saving} disabled={firstRun && !linkTarget}>
                  Save
                </Button>
              </HStack>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
