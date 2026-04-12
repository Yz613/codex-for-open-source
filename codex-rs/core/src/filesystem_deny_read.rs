use std::path::Path;
use std::path::PathBuf;

use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSpecialPath;
use codex_utils_absolute_path::AbsolutePathBuf;

use crate::function_tool::FunctionCallError;

const DENY_READ_POLICY_MESSAGE: &str =
    "access denied: reading this path is blocked by filesystem deny_read policy";

pub(crate) struct ReadDenyMatcher {
    denied_candidates: Vec<Vec<PathBuf>>,
    root_deny_policy: Option<RootDenyPolicy>,
}

struct RootDenyPolicy {
    file_system_sandbox_policy: FileSystemSandboxPolicy,
    cwd: PathBuf,
}

impl ReadDenyMatcher {
    pub(crate) fn new(
        file_system_sandbox_policy: &FileSystemSandboxPolicy,
        cwd: &Path,
    ) -> Option<Self> {
        if !file_system_sandbox_policy.has_denied_read_restrictions() {
            return None;
        }

        let denied_candidates = file_system_sandbox_policy
            .get_unreadable_roots_with_cwd(cwd)
            .into_iter()
            .map(|path| normalized_and_canonical_candidates(path.as_path()))
            .collect();
        let has_root_deny = file_system_sandbox_policy.entries.iter().any(|entry| {
            entry.access == FileSystemAccessMode::None
                && matches!(
                    entry.path,
                    FileSystemPath::Special {
                        value: FileSystemSpecialPath::Root,
                    }
                )
        });
        let root_deny_policy = if has_root_deny {
            Some(RootDenyPolicy {
                file_system_sandbox_policy: file_system_sandbox_policy.clone(),
                cwd: cwd.to_path_buf(),
            })
        } else {
            None
        };
        Some(Self {
            denied_candidates,
            root_deny_policy,
        })
    }

    pub(crate) fn is_read_denied(&self, path: &Path) -> bool {
        let path_candidates = normalized_and_canonical_candidates(path);
        if matches_any_candidate_prefix(&path_candidates, &self.denied_candidates) {
            return true;
        }

        self.root_deny_policy
            .as_ref()
            .is_some_and(|root_deny_policy| {
                !root_deny_policy
                    .file_system_sandbox_policy
                    .can_read_path_with_cwd(path, root_deny_policy.cwd.as_path())
            })
    }
}

pub(crate) fn ensure_read_allowed(
    path: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> Result<(), FunctionCallError> {
    if ReadDenyMatcher::new(file_system_sandbox_policy, cwd)
        .is_some_and(|matcher| matcher.is_read_denied(path))
    {
        return Err(FunctionCallError::RespondToModel(format!(
            "{DENY_READ_POLICY_MESSAGE}: `{}`",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn is_read_denied(
    path: &Path,
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &Path,
) -> bool {
    ReadDenyMatcher::new(file_system_sandbox_policy, cwd)
        .is_some_and(|matcher| matcher.is_read_denied(path))
}

fn normalized_and_canonical_candidates(path: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(normalized) = AbsolutePathBuf::from_absolute_path(path) {
        push_unique(&mut candidates, normalized.to_path_buf());
    } else {
        push_unique(&mut candidates, path.to_path_buf());
    }

    if let Ok(canonical) = path.canonicalize()
        && let Ok(canonical_absolute) = AbsolutePathBuf::from_absolute_path(canonical)
    {
        push_unique(&mut candidates, canonical_absolute.to_path_buf());
    }

    candidates
}

fn matches_any_candidate_prefix(
    path_candidates: &[PathBuf],
    candidate_sets: &[Vec<PathBuf>],
) -> bool {
    candidate_sets.iter().any(|candidates| {
        path_candidates.iter().any(|path_candidate| {
            candidates.iter().any(|candidate| {
                path_candidate == candidate || path_candidate.starts_with(candidate)
            })
        })
    })
}

fn push_unique(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

#[cfg(test)]
mod tests {
    use codex_protocol::permissions::FileSystemAccessMode;
    use codex_protocol::permissions::FileSystemPath;
    use codex_protocol::permissions::FileSystemSandboxEntry;
    use codex_protocol::permissions::FileSystemSpecialPath;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    use super::is_read_denied;
    use super::*;

    fn deny_policy(path: &std::path::Path) -> FileSystemSandboxPolicy {
        FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry {
            path: FileSystemPath::Path {
                path: AbsolutePathBuf::try_from(path).expect("absolute deny path"),
            },
            access: FileSystemAccessMode::None,
        }])
    }

    fn root_deny_with_readable_carveout_policy(path: &std::path::Path) -> FileSystemSandboxPolicy {
        FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::None,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path {
                    path: AbsolutePathBuf::try_from(path).expect("absolute readable path"),
                },
                access: FileSystemAccessMode::Read,
            },
        ])
    }

    fn root_deny_with_readable_carveout_and_nested_deny_policy(
        readable_path: &std::path::Path,
        denied_path: &std::path::Path,
    ) -> FileSystemSandboxPolicy {
        FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry {
                path: FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                access: FileSystemAccessMode::None,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path {
                    path: AbsolutePathBuf::try_from(readable_path).expect("absolute readable path"),
                },
                access: FileSystemAccessMode::Read,
            },
            FileSystemSandboxEntry {
                path: FileSystemPath::Path {
                    path: AbsolutePathBuf::try_from(denied_path).expect("absolute denied path"),
                },
                access: FileSystemAccessMode::None,
            },
        ])
    }

    #[test]
    fn exact_path_and_descendants_are_denied() {
        let temp = tempdir().expect("temp dir");
        let denied_dir = temp.path().join("denied");
        let nested = denied_dir.join("nested.txt");
        std::fs::create_dir_all(&denied_dir).expect("create denied dir");
        std::fs::write(&nested, "secret").expect("write secret");

        let policy = deny_policy(&denied_dir);
        assert_eq!(is_read_denied(&denied_dir, &policy, temp.path()), true);
        assert_eq!(is_read_denied(&nested, &policy, temp.path()), true);
        assert_eq!(
            is_read_denied(&temp.path().join("other.txt"), &policy, temp.path()),
            false
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_target_matches_denied_symlink_alias() {
        use std::os::unix::fs::symlink;

        let temp = tempdir().expect("temp dir");
        let real_dir = temp.path().join("real");
        let alias_dir = temp.path().join("alias");
        std::fs::create_dir_all(&real_dir).expect("create real dir");
        symlink(&real_dir, &alias_dir).expect("symlink alias");

        let secret = real_dir.join("secret.txt");
        std::fs::write(&secret, "secret").expect("write secret");
        let alias_secret = alias_dir.join("secret.txt");

        let policy = deny_policy(&real_dir);
        assert_eq!(is_read_denied(&alias_secret, &policy, temp.path()), true);
    }

    #[test]
    fn root_deny_blocks_paths_outside_readable_carveout() {
        let temp = tempdir().expect("temp dir");
        let readable_dir = temp.path().join("readable");
        let blocked_dir = temp.path().join("blocked");
        std::fs::create_dir_all(&readable_dir).expect("create readable dir");
        std::fs::create_dir_all(&blocked_dir).expect("create blocked dir");

        let policy = root_deny_with_readable_carveout_policy(&readable_dir);
        assert_eq!(
            is_read_denied(&blocked_dir.join("secret.txt"), &policy, temp.path()),
            true
        );
        assert_eq!(
            is_read_denied(&readable_dir.join("visible.txt"), &policy, temp.path()),
            false
        );
    }

    #[test]
    fn explicit_deny_inside_root_deny_carveout_still_wins() {
        let temp = tempdir().expect("temp dir");
        let readable_dir = temp.path().join("readable");
        let denied_dir = readable_dir.join("private");
        std::fs::create_dir_all(&denied_dir).expect("create denied dir");

        let policy =
            root_deny_with_readable_carveout_and_nested_deny_policy(&readable_dir, &denied_dir);
        assert_eq!(
            is_read_denied(&readable_dir.join("visible.txt"), &policy, temp.path()),
            false
        );
        assert_eq!(
            is_read_denied(&denied_dir.join("secret.txt"), &policy, temp.path()),
            true
        );
    }
}
