# Matterport 3DVG Annotator

一个基于Web的Matterport 3D场景标注工具，专为3D视觉接地（Visual Grounding）任务设计。该工具提供直观的交互界面，支持在3D场景中选择对象并添加文本描述和查询标注。

## 功能特性

### 🎯 核心功能
- **3D场景可视化**：基于Three.js渲染Matterport场景的PLY格式数据
- **交互式对象选择**：点击3D场景中的对象进行精确选择
- **智能标注系统**：为选中对象添加标签、查询描述和边界框信息
- **区域信息管理**：自动解析并支持修正对象所属房间区域
- **标注数据持久化**：以JSONL格式保存所有标注信息

### 🎮 交互控制
- **多视角切换**：支持前视图、后视图、双面视图模式
- **预设视角**：快速切换到顶部、底部、前后左右6个标准视角
- **键盘控制**：WASDQE移动，ZC转向，VB俯仰，F聚焦选中对象
- **高亮显示**：选中对象的黄色高亮和边界框可视化
- **已标注可视化**：绿色标记显示已完成标注的对象

### 📊 数据管理
- **类别映射**：支持预定义的对象类别标签系统
- **增量标注**：自动加载和显示已有标注数据
- **实时保存**：标注完成后立即保存到服务器
- **边界框计算**：自动计算选中对象的3D边界框

## 技术架构

```
Frontend (Browser)          Backend (Flask)           Data Storage
┌─────────────────┐        ┌─────────────────┐       ┌─────────────────┐
│   Three.js      │        │   Flask App     │       │  PLY Files      │
│   - Scene       │◄──────►│   - Scene Load  │◄─────►│  - Vertices     │
│   - Renderer    │        │   - Data Process│       │  - Faces        │
│   - Controls    │        │   - Annotations │       │  - Segments     │
│                 │        │                 │       │                 │
│   HTML/CSS/JS   │        │   Trimesh       │       │  .house Files   │
│   - UI Controls │◄──────►│   - PLY Parse   │◄─────►│  - Regions      │
│   - Annotations │        │   - GLB Export  │       │  - Mappings     │
│                 │        │                 │       │                 │
│   Interaction   │        │   NumPy         │       │  Annotations    │
│   - Click Select│◄──────►│   - Face Maps   │◄─────►│  - JSONL Files  │
│   - Keyboard    │        │   - Instance ID │       │  - Labels       │
└─────────────────┘        └─────────────────┘       └─────────────────┘
```

## 安装指南

### 环境要求
- Python 3.8+
- 现代浏览器（支持WebGL 2.0）
- 4GB+ 内存（处理大型3D场景）

### 依赖安装

```bash
# 克隆项目
git clone https://github.com/your-username/matterport-annotator.git
cd matterport-annotator

# 创建虚拟环境
python -m venv venv
source venv/bin/activate  # Linux/Mac
# 或
venv\Scripts\activate  # Windows

# 安装依赖
pip install -r requirements.txt
```

### 目录结构

```
matterport_annotator/
├── app.py                  # Flask主应用
├── requirements.txt        # Python依赖
├── templates/
│   └── index.html         # 主页面模板
├── static/
│   ├── css/
│   │   └── style.css      # 样式文件
│   └── js/
│       ├── main.js        # 前端核心逻辑
│       └── OrbitControls.js # Three.js相机控制
├── data/                  # 3D场景数据目录
│   ├── scene_id/
│   │   ├── house_segmentations/
│   │   │   ├── scene_id.ply    # 3D网格数据
│   │   │   └── scene_id.house  # 房间区域数据
│   └── catergory_mapping.txt   # 对象类别映射
├── annotations/           # 标注数据存储
├── temp_glb/             # 临时GLB文件缓存
└── README.md
```

## 使用指南

### 1. 数据准备

#### PLY文件格式要求
PLY文件必须包含以下属性：
- **顶点属性**：`x`, `y`, `z`（坐标），`red`, `green`, `blue`（颜色）
- **面属性**：`vertex_indices`（顶点索引），`segment_id`（实例ID），`category_id`（类别ID）

#### .house文件格式
```
E object_index ply_id house_object_index    # PLY ID映射
O house_object_index region_index           # 对象到区域映射  
R region_index ... ... ... region_code     # 区域定义
```

#### 类别映射文件
```
category_id    nyu40_label    object_label
1              wall           wall
2              floor          floor
...
```

### 2. 启动服务

```bash
python app.py
```

服务启动后访问：`http://127.0.0.1:5003`

### 3. 标注流程

#### 基本操作
1. **选择场景**：从下拉菜单选择要标注的场景ID
2. **加载场景**：点击"Load Scene"按钮加载3D场景
3. **对象选择**：在3D场景中点击要标注的对象
4. **确认选择**：在弹出的确认面板中查看对象信息并确认
5. **标注编辑**：
   - 修改最终标签（如有需要）
   - 输入查询描述
   - 选择正确的房间区域（可选）
6. **保存标注**：点击"Save Annotation"保存标注

#### 视角控制

**鼠标操作**：
- 左键拖拽：旋转视角
- 滚轮：缩放
- 右键拖拽：平移

**键盘快捷键**：
- `W/A/S/D`：前后左右移动
- `Q/E`：上下移动
- `Z/C`：左右转向
- `V/B`：上下俯仰
- `F`：聚焦到选中对象
- `Shift`：加速移动

**预设视角**：使用界面上的按钮快速切换到标准视角（顶部、底部、前后左右）

#### 视图模式
- **Standard (Front)**：显示正面
- **Interior (Back)**：显示背面（适合室内场景）
- **Both Sides**：双面显示

### 4. 标注数据格式

标注数据以JSONL格式保存在`annotations/`目录下：

```json
{
  "scene_id": "scene_001",
  "instance_id": "123", 
  "final_label": "chair",
  "final_label_id": 56,
  "original_category_id": 56,
  "region_label": "living room",
  "region_code": "l",
  "bounding_box": {
    "min": {"x": -1.2, "y": 0.3, "z": 0.0},
    "max": {"x": -0.4, "y": 1.1, "z": 0.8}
  },
  "query": "a brown leather chair facing the window",
  "timestamp": "2024-04-18 10:30:15"
}
```

## API文档

### 后端接口

#### GET `/`
返回主页面

#### GET `/load_scene/<scene_id>`
加载指定场景的3D数据

**响应**：
```json
{
  "status": "success",
  "glb_url": "/temp_files/scene.glb",
  "details_url": "/temp_files/scene_details.json", 
  "face_map_url": "/temp_files/scene_face_map.bin",
  "existing_annotations": {...}
}
```

#### POST `/save_annotation`
保存标注数据

**请求体**：
```json
{
  "scene_id": "scene_001",
  "instance_id": "123",
  "original_category_id": 56,
  "final_label_string": "chair",
  "query": "a brown leather chair",
  "bounding_box": {...},
  "region_label": "living room",
  "region_code": "l"
}
```

#### GET `/temp_files/<filename>`
提供临时文件下载（GLB模型、实例详情、面映射等）

### 前端主要函数

#### 场景管理
- `loadSelectedScene()`: 加载选中的场景
- `clearScene()`: 清理当前场景
- `displayExistingAnnotations()`: 显示已有标注

#### 交互处理  
- `onPointerDown()`: 处理鼠标点击选择
- `handleConfirmSelection()`: 确认对象选择
- `highlightInstance()`: 高亮显示选中对象

#### 视角控制
- `setPresetView()`: 设置预设视角
- `handleKeyboardInput()`: 处理键盘输入
- `focusOnSelectedObject()`: 聚焦到选中对象

## 配置说明

### 主要配置参数

在`app.py`中可调整的配置：

```python
MATTERPORT_DATA_DIR = './data/'           # 数据目录
ANNOTATION_DIR = './annotations/'         # 标注保存目录  
TEMP_DIR = './temp_glb/'                 # 临时文件目录
LABEL_INFO_FILE = './data/catergory_mapping.txt'  # 类别映射文件
FACE_MAP_DTYPE = np.int32                # 面映射数据类型
```

### 区域代码映射

```python
REGION_CODE_TO_LABEL = {
    'a': "bathroom", 'b': "bedroom", 'c': "closet", 
    'd': "dining room", 'e': "entryway/foyer/lobby",
    'f': "familyroom", 'g': "garage", 'h': "hallway",
    'k': "kitchen", 'l': "living room", 'o': "office",
    # ... 更多区域定义
}
```

## 性能优化

### 大场景处理
- **内存优化**：使用二进制面映射减少内存占用
- **数据预处理**：离线生成GLB文件减少在线处理时间
- **分块加载**：支持大场景的分块渲染
- **缓存机制**：临时文件缓存避免重复计算

### 建议的硬件配置
- **CPU**：4核以上处理器
- **内存**：8GB以上（大场景需要16GB+）
- **显卡**：支持WebGL 2.0的独立显卡
- **存储**：SSD推荐（加快文件读取）

## 故障排除

### 常见问题

**1. 场景加载失败**
- 检查PLY文件格式和路径
- 确认文件权限和大小限制
- 查看浏览器控制台错误信息

**2. 内存不足崩溃**
- 尝试更小的测试场景
- 增加系统虚拟内存
- 考虑分块处理大场景

**3. 点击选择无响应**
- 确认scene已完全加载
- 检查浏览器WebGL支持
- 重新加载页面重试

**4. 标注保存失败**
- 检查annotations目录写入权限
- 确认网络连接正常
- 查看服务器日志错误信息

### 调试技巧

启用调试模式：
```python
app.run(debug=True, host='127.0.0.1', port=5003)
```

浏览器开发者工具：
- Console：查看JavaScript错误
- Network：检查网络请求状态
- Performance：分析渲染性能

## 开发指南

### 代码结构

**后端（app.py）**：
- Flask路由处理
- PLY文件解析（使用trimesh和plyfile）
- 数据预处理和GLB导出
- 标注数据管理

**前端（main.js）**：
- Three.js 3D渲染
- 用户交互处理
- UI状态管理
- 键盘控制逻辑

### 扩展功能

**添加新的标注类型**：
1. 修改标注数据结构
2. 更新前端UI组件
3. 扩展保存接口

**支持新的3D格式**：
1. 在后端添加新的加载器
2. 统一数据格式转换
3. 更新前端渲染逻辑

**集成机器学习模型**：
1. 添加预测接口
2. 实现主动学习
3. 支持批量标注

## 贡献指南

欢迎提交Issue和Pull Request！

### 开发流程
1. Fork本项目
2. 创建特性分支：`git checkout -b feature/new-feature`
3. 提交更改：`git commit -am 'Add new feature'`
4. 推送分支：`git push origin feature/new-feature`
5. 提交Pull Request

### 代码规范
- Python代码遵循PEP 8规范
- JavaScript使用ES6+语法
- 添加适当的注释和文档
- 包含必要的测试用例

## 许可证

本项目采用 MIT 许可证

## 引用

如果此工具对您的研究有帮助，请考虑引用：

```bibtex
@misc{matterport-annotator,
  title={Matterport 3DVG Annotator: A Web-based Tool for 3D Visual Grounding Annotation},
  author={Jiawei LI},
  year={2024},
  url={https://github.com/adrianJW421/Complex-3D-Scene-Anotator.git}
}
```

## 联系方式

- 项目主页：https://github.com/your-username/matterport-annotator  
- 问题反馈：https://github.com/your-username/matterport-annotator/issues
- 邮箱：your.email@example.com

---

**注意**：本工具专为研究目的设计，请确保遵守Matterport数据的使用条款和相关法规。