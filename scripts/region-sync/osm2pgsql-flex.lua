local stage_table_name = os.getenv('OSM2PGSQL_STAGE_TABLE') or 'region_import_stage'
local stage_schema_name = os.getenv('OSM2PGSQL_OUTPUT_SCHEMA')

if stage_schema_name ~= nil and stage_schema_name == '' then
    stage_schema_name = nil
end

local buildings = osm2pgsql.define_table({
    name = stage_table_name,
    schema = stage_schema_name,
    ids = { type = 'any', id_column = 'osm_id', type_column = 'osm_type_code' },
    columns = {
        { column = 'feature_kind', type = 'text', not_null = true },
        { column = 'tags_json', type = 'jsonb' },
        { column = 'min_lon', type = 'real', not_null = true },
        { column = 'min_lat', type = 'real', not_null = true },
        { column = 'max_lon', type = 'real', not_null = true },
        { column = 'max_lat', type = 'real', not_null = true },
        { column = 'geom', type = 'multipolygon', projection = 4326, not_null = true }
    }
})

local function is_truthy_building_tag(value)
    if value == nil then
        return false
    end

    local text = tostring(value)
    if text == '' then
        return false
    end

    text = string.lower(text)
    return text ~= '0' and text ~= 'false' and text ~= 'no'
end

local function resolve_feature_kind(tags)
    if is_truthy_building_tag(tags['building:part']) then
        return 'building_part'
    end
    return 'building'
end

local function process_building_object(object)
    local tags = object.tags
    if not tags then
        return
    end

    if not is_truthy_building_tag(tags.building) and not is_truthy_building_tag(tags['building:part']) then
        return
    end

    local geom = object:as_multipolygon()
    if geom == nil then
        return
    end

    local min_lon, min_lat, max_lon, max_lat = object:get_bbox()
    if min_lon == nil or min_lat == nil or max_lon == nil or max_lat == nil then
        return
    end

    buildings:insert({
        feature_kind = resolve_feature_kind(tags),
        tags_json = tags,
        min_lon = min_lon,
        min_lat = min_lat,
        max_lon = max_lon,
        max_lat = max_lat,
        geom = geom
    })
end

function osm2pgsql.process_way(object)
    process_building_object(object)
end

function osm2pgsql.process_relation(object)
    process_building_object(object)
end
