# --- START OF FILE app.py ---
import os
import json
import time
import logging
import numpy as np
from flask import Flask, render_template, request, jsonify, abort, send_from_directory
import threading

# --- 配置 ---
ANNOTATION_DIR = './annotations/'
LABEL_INFO_FILE = './data/catergory_mapping.txt'
# 使用由 spark 预处理脚本生成的目录
TEMP_DIR = './temp_glb_spark/'

# --- 预处理文件的命名约定 ---
PREPROCESSED_GLB_PATTERN = "{scene_id}_mesh.glb"
PREPROCESSED_DETAILS_PATTERN = "{scene_id}_details.json"
PREPROCESSED_MAP_PATTERN = "{scene_id}_face_map.bin"

# --- 区域标签映射 (保留，并且作为有效区域列表的来源) ---
REGION_CODE_TO_LABEL = {
    'a': "bathroom", 'b': "bedroom", 'c': "closet", 'd': "dining room", 'e': "entryway/foyer/lobby",
    'f': "familyroom", 'g': "garage", 'h': "hallway", 'i': "library", 'j': "laundryroom/mudroom",
    'k': "kitchen", 'l': "living room", 'm': "meetingroom/conferenceroom", 'n': "lounge",
    'o': "office", 'p': "porch/terrace/deck/driveway", 'r': "rec/game", 's': "stairs",
    't': "toilet", 'u': "utilityroom/toolroom", 'v': "tv", 'w': "workout/gym/exercise",
    'x': "outdoor", 'y': "balcony", 'z': "other room", 'B': "bar", 'C': "classroom",
    'D': "dining booth", 'S': "spa/sauna", 'Z': "junk", '-': "no label"
}

# --- Flask App 设置 ---
app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logging.getLogger('werkzeug').setLevel(logging.INFO)

# --- 全局标签变量 ---
known_labels_lock = threading.Lock()
known_labels_by_name = {}
known_labels_by_id = {}
next_new_label_id = 1660

# 创建目录
for dir_path in [ANNOTATION_DIR]:
    if not os.path.exists(dir_path):
        try:
            os.makedirs(dir_path)
            logging.info(f"Created directory: {dir_path}")
        except OSError as e:
            logging.error(f"Could not create directory {dir_path}: {e}")

# --- 帮助函数 ---
def load_known_labels():
    """加载 catergory_mapping.txt 中的已知对象标签。"""
    global next_new_label_id, known_labels_by_name, known_labels_by_id
    logging.info(f"Loading known labels from {LABEL_INFO_FILE}...")
    temp_labels_by_name = {}
    temp_labels_by_id = {}
    max_id_from_file = 0
    try:
        # (函数内容保持不变)
        with open(LABEL_INFO_FILE, 'r', encoding='utf-8') as f:
            header = next(f, None)
            logging.info(f"Label file header: {header.strip() if header else 'None'}")
            for line_num, line in enumerate(f, 2):
                parts = line.strip().split('\t')
                if len(parts) >= 3:
                    try:
                        category_id = int(parts[0])
                        label_name = parts[2].strip()
                        if label_name and label_name not in ['void', 'unlabeled', 'remove', 'delete', 'unknown']:
                            canonical_name = label_name.replace('_', ' ')
                            temp_labels_by_id[category_id] = {'name': canonical_name}
                            temp_labels_by_name[label_name.lower()] = {'id': category_id, 'canonical_name': canonical_name}
                            max_id_from_file = max(max_id_from_file, category_id)
                        # else: logging.debug(...) # 可选
                    except (ValueError, IndexError) as parse_err:
                        logging.warning(f"Could not parse label file line {line_num}: '{line.strip()}'. Error: {parse_err}")
                # else: logging.warning(...) # 可选
        with known_labels_lock:
            known_labels_by_id = temp_labels_by_id
            known_labels_by_name = temp_labels_by_name
            next_new_label_id = max(1660, max_id_from_file + 1)
        logging.info(f"Loaded {len(known_labels_by_id)} known labels. Next new ID: {next_new_label_id}")
    except FileNotFoundError:
        logging.error(f"Label info file not found: {LABEL_INFO_FILE}. Cannot establish canonical labels.", exc_info=True)
        # Consider raising an error or exiting if labels are critical
    except Exception as e:
        logging.error(f"Error loading known labels: {e}", exc_info=True)

def get_scene_list():
    """获取可用场景列表 (基于 TEMP_DIR 中存在的预处理文件)。"""
    scenes = set()
    if not os.path.exists(TEMP_DIR):
        logging.warning(f"Preprocessed data directory not found: {TEMP_DIR}")
        return []
    logging.info(f"Scanning for preprocessed scenes in: {TEMP_DIR}")
    try:
        # (函数内容保持不变)
        for filename in os.listdir(TEMP_DIR):
            if filename.endswith("_mesh.glb"):
                scene_id = filename[:-len("_mesh.glb")]
                details_path = os.path.join(TEMP_DIR, PREPROCESSED_DETAILS_PATTERN.format(scene_id=scene_id))
                map_path = os.path.join(TEMP_DIR, PREPROCESSED_MAP_PATTERN.format(scene_id=scene_id))
                if os.path.exists(details_path) and os.path.exists(map_path):
                    scenes.add(scene_id)
                else:
                    logging.warning(f"Found mesh for {scene_id} but missing details/map file. Skipping.")
    except OSError as e:
        logging.error(f"Error reading preprocessed directory {TEMP_DIR}: {e}")
    available_scenes = sorted(list(scenes))
    logging.info(f"Found {len(available_scenes)} preprocessed scenes.")
    return available_scenes

def load_existing_annotations(scene_id):
    """加载场景的现有注释文件 (.jsonl)。"""
    # (函数内容保持不变)
    annotations = {}
    annotation_file = os.path.join(ANNOTATION_DIR, f"{scene_id}.jsonl")
    if not os.path.exists(annotation_file):
        # logging.info(...)
        return annotations
    # logging.info(...)
    try:
        with open(annotation_file, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line: continue
                try:
                    data = json.loads(line)
                    instance_id = str(data.get("instance_id"))
                    if not instance_id: continue # Skip if no ID
                    annotations[instance_id] = {
                        "finalLabel": data.get("final_label", "N/A"),
                        "query": data.get("query", ""),
                        "boundingBox": data.get("bounding_box")
                    }
                except json.JSONDecodeError: pass # Ignore lines that aren't valid JSON
                except KeyError: pass # Ignore lines missing keys
    except IOError as e: logging.error(f"IOError loading annotations for {scene_id}: {e}")
    except Exception as e: logging.error(f"Unexpected error loading annotations for {scene_id}: {e}", exc_info=True)
    # logging.info(...)
    return annotations

# --- Flask 路由 ---
@app.route('/')
def index():
    scenes = get_scene_list()
    return render_template('index.html', scenes=scenes)

# +++ 新增路由：提供区域列表 +++
@app.route('/get_regions')
def get_regions():
    """返回有效的区域代码和标签映射给前端。"""
    logging.debug("Request received for /get_regions")
    # 直接返回全局字典
    # 也可以只返回标签列表: jsonify(list(REGION_CODE_TO_LABEL.values()))
    # 返回 code -> label 映射更灵活
    return jsonify(REGION_CODE_TO_LABEL)
# ++++++++++++++++++++++++++++++++

@app.route('/load_scene/<scene_id>')
def get_scene(scene_id):
    """检查预处理文件并返回其 URL。"""
    logging.info(f"--- Request to load preprocessed scene: {scene_id} ---")
    start_time = time.time()

    # 1. 构造预期文件路径
    glb_filename = PREPROCESSED_GLB_PATTERN.format(scene_id=scene_id)
    details_filename = PREPROCESSED_DETAILS_PATTERN.format(scene_id=scene_id)
    face_map_filename = PREPROCESSED_MAP_PATTERN.format(scene_id=scene_id)
    glb_filepath = os.path.join(TEMP_DIR, glb_filename)
    details_filepath = os.path.join(TEMP_DIR, details_filename)
    face_map_filepath = os.path.join(TEMP_DIR, face_map_filename)

    # 2. 检查文件是否存在
    missing_files = []
    if not os.path.exists(glb_filepath): missing_files.append(glb_filename)
    if not os.path.exists(details_filepath): missing_files.append(details_filename)
    if not os.path.exists(face_map_filepath): missing_files.append(face_map_filename)
    if missing_files:
        error_msg = f"Preprocessed files missing for scene {scene_id}: {', '.join(missing_files)}"
        logging.error(error_msg)
        abort(404, description=error_msg)

    # 3. 加载现有注释
    try:
        existing_annotations = load_existing_annotations(scene_id)
    except Exception as e:
        logging.error(f"Error loading existing annotations for {scene_id}: {e}", exc_info=True)
        existing_annotations = {} # 出错时返回空注释

    # 4. 构造返回 URL
    glb_url = f"/temp_files/{glb_filename}"
    details_url = f"/temp_files/{details_filename}"
    face_map_url = f"/temp_files/{face_map_filename}"

    load_time = time.time() - start_time
    logging.info(f"Preprocessed scene '{scene_id}' check completed in {load_time:.2f} seconds.")
    # logging.info(...) # 日志中不再打印 URL

    # 5. 返回成功响应
    return jsonify({
        "status": "success",
        "glb_url": glb_url,
        "details_url": details_url,
        "face_map_url": face_map_url,
        "existing_annotations": existing_annotations
    })

@app.route('/temp_files/<path:filename>')
def serve_temp_file(filename):
    """提供预处理文件。"""
    # (函数内容保持不变)
    if '..' in filename or filename.startswith('/'): abort(404)
    allowed_extensions = ('.glb', '.json', '.bin')
    if not filename.endswith(allowed_extensions): abort(403)
    logging.debug(f"Serving preprocessed file: {filename} from {TEMP_DIR}")
    try:
        mimetype = None
        if filename.endswith('.glb'): mimetype = 'model/gltf-binary'
        elif filename.endswith('.json'): mimetype = 'application/json'
        elif filename.endswith('.bin'): mimetype = 'application/octet-stream'
        response = send_from_directory(TEMP_DIR, filename, as_attachment=False, mimetype=mimetype)
        # 设置缓存控制（保持不缓存，或改为公共缓存）
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        # response.headers["Cache-Control"] = "public, max-age=3600" # 示例：缓存1小时
        return response
    except FileNotFoundError: abort(404)
    except Exception as e: logging.error(f"Error serving file {filename}: {e}"); abort(500)

# --- 修改: /save_annotation 现在接收最终区域信息 ---
@app.route('/save_annotation', methods=['POST'])
def save_annotation():
    """保存单个注释条目，包括用户可能修改过的区域标签。"""
    global next_new_label_id
    if not request.json:
        abort(400, description="Missing JSON body.")

    # 验证必需字段
    # 注意：现在需要从前端接收 final_region_label 和 final_region_code
    required_keys = [
        'scene_id', 'instance_id', 'original_category_id',
        'final_label_string', 'query',
        'final_region_label', 'final_region_code' # <<< 新增必需字段
    ]
    data = request.json
    if not all(k in data for k in required_keys):
        missing = [k for k in required_keys if k not in data]
        logging.error(f"Missing annotation data: {', '.join(missing)}. Data received: {data}")
        abort(400, description=f"Missing required annotation data: {', '.join(missing)}")

    scene_id = data['scene_id']
    instance_id_str = str(data['instance_id'])
    original_category_id = data['original_category_id']
    final_label_string = data['final_label_string'].strip()
    query = data['query']
    bounding_box_data = data.get('bounding_box', None) # Bbox 仍然是可选的

    # <<< 获取前端选择的最终区域信息 >>>
    final_region_label = data['final_region_label']
    final_region_code = data['final_region_code']

    if not final_label_string: abort(400, description="Final label string cannot be empty.")
    # （可选）可以添加对 final_region_label 和 final_region_code 的验证
    if not final_region_label or final_region_label == "-- Select Region --":
        abort(400, description="A valid final region must be selected.")
    if final_region_code not in REGION_CODE_TO_LABEL:
         logging.warning(f"Received potentially invalid final_region_code: '{final_region_code}' for label '{final_region_label}'")
         # 这里可以选择是接受、拒绝还是尝试修复

    # 处理对象标签 (逻辑不变)
    final_label_canonical = ""
    final_label_id = -1
    with known_labels_lock:
        search_label = final_label_string.lower()
        if search_label in known_labels_by_name:
            label_info = known_labels_by_name[search_label]
            final_label_id = label_info['id']
            final_label_canonical = label_info['canonical_name']
            # logging.info(...)
        else:
            final_label_id = next_new_label_id
            final_label_canonical = final_label_string
            known_labels_by_name[search_label] = {'id': final_label_id, 'canonical_name': final_label_canonical}
            known_labels_by_id[final_label_id] = {'name': final_label_canonical}
            logging.info(f"Assigning new ID {final_label_id} to new object label '{final_label_canonical}'")
            next_new_label_id += 1

    # 准备注释条目，使用最终的区域信息
    annotation_file = os.path.join(ANNOTATION_DIR, f"{scene_id}.jsonl")
    annotation_entry = {
        "scene_id": scene_id,
        "instance_id": instance_id_str,
        "final_label": final_label_canonical,
        "final_label_id": final_label_id,
        "original_category_id": original_category_id,
        "region_label": final_region_label, # <<< 使用最终选择的区域标签
        "region_code": final_region_code,   # <<< 使用最终选择的区域代码
        "bounding_box": bounding_box_data,
        "query": query,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    }

    # 写入文件 (逻辑不变)
    try:
        os.makedirs(ANNOTATION_DIR, exist_ok=True)
        with open(annotation_file, 'a', encoding='utf-8') as f:
            json.dump(annotation_entry, f, ensure_ascii=False)
            f.write('\n')
        logging.info(f"Saved annotation for scene {scene_id}, instance {instance_id_str}. Object Label: '{final_label_canonical}', Region: '{final_region_label}'")
        return jsonify({
            "status": "success",
            "message": "Annotation saved.",
            "saved_label": final_label_canonical,
            "saved_label_id": final_label_id
        })
    except IOError as e:
        logging.error(f"Failed to save annotation to {annotation_file} due to file system error: {e}", exc_info=True)
        abort(500, description="Failed to save annotation due to file system error.")
    except Exception as e:
        logging.error(f"Failed to save annotation to {annotation_file} due to an unexpected error: {e}", exc_info=True)
        abort(500, description="Failed to save annotation due to an unexpected error.")

# --- 运行 App ---
if __name__ == '__main__':
    load_known_labels()
    app.run(debug=True, host='127.0.0.1', port=5004) # 使用不同端口以防冲突
# --- END OF FILE app.py ---