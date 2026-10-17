export type TreeNode<T = unknown> = {
  name: string;
  path: string;
  type: "folder" | "file";
  children?: TreeNode<T>[];
  file?: T;
};

export function buildTree<T extends { path: string }>(items: T[]): TreeNode<T> {
  const root: TreeNode<T> = {
    name: "",
    path: "",
    type: "folder",
    children: [],
  };
  for (const file of items) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isFile = i === parts.length - 1;
      if (!current.children) current.children = [];
      let child = current.children.find((c) => c.name === part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          type: isFile ? "file" : "folder",
        };
        current.children.push(child);
      }
      if (isFile) {
        child.file = file;
      } else {
        if (!child.children) child.children = [];
      }
      current = child;
    }
  }
  const sortNode = (node: TreeNode<T>) => {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

export function filterTree<T>(
  node: TreeNode<T>,
  query: string,
): TreeNode<T> | null {
  if (!query) return node;
  const q = query.toLowerCase();
  if (node.type === "file") {
    return node.path.toLowerCase().includes(q) ? node : null;
  }
  const children = (node.children ?? [])
    .map((child) => filterTree(child, query))
    .filter((child): child is TreeNode<T> => Boolean(child));
  if (children.length > 0 || node.path.toLowerCase().includes(q)) {
    return { ...node, children };
  }
  return null;
}
