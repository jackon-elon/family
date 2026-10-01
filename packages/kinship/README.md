# 家庭称呼计算模块

`src/index.ts` 是无云端依赖的 TypeScript 纯函数。页面可用它展示当前视角的关系路径与称呼；服务端仍需按圈子校验成员权限，并且只向客户端返回当前成员获准查看的人物和关系。

```ts
import { resolveKinship } from './packages/kinship/src/index';

const result = resolveKinship({
  people: [
    { id: 'me', gender: 'female' },
    { id: 'dad', gender: 'male' },
    { id: 'uncle', gender: 'male' },
  ],
  relations: [
    { type: 'parent_child', parentId: 'dad', childId: 'me' },
    { type: 'sibling', personAId: 'dad', personBId: 'uncle', olderPersonId: 'uncle' },
  ],
  perspectiveId: 'me',
  targetId: 'uncle',
});

// result.status === 'resolved'
// result.term === '伯父'
// result.alternatives === ['伯伯']
// result.path?.display === '我 → 爸爸 → 爸爸的哥哥'
```

`status` 取值：

- `resolved`：规则能确定称呼。
- `pending`：缺少性别、长幼等信息，或路径尚未覆盖；显示 `path.display`、`missing`、`reason`。
- `ambiguous`：多条最短路径冲突或过多，需人工核对。
- `self`：目标即当前视角人物。
- `unrelated`：两人尚无已录入的连接关系。
- `invalid`：人物或关系数据有错误，例如亲子循环。

个人常用叫法与圈内叫法写在 `overrides` 中。个人优先；`term` 是展示叫法，`calculatedTerm` 保留自动称呼，`status` 仍反映底层关系的计算状态。自定义叫法不会让未连接的人物变成已确认的亲属。

运行测试（Node.js 22.16+）：

```powershell
node --experimental-strip-types --test packages/kinship/test/kinship.test.mjs
```
